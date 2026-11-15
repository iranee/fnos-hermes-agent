import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

const MESSAGES = {
  "process-options": "Invalid kernel process options",
  "process-spawn": "Cannot start kernel process",
  "process-exit": "Kernel process exited unsuccessfully",
  "process-aborted": "Kernel process was interrupted",
  "process-timeout": "Kernel process timed out",
  "process-output-limit": "Kernel process output exceeded its byte limit",
  "process-log-failed": "Kernel process output consumer failed",
  "process-cleanup": "Cannot confirm kernel process cleanup",
};
function failure(code, exitCode) {
  const error = new Error(MESSAGES[code]);
  error.code = code;
  if (Number.isInteger(exitCode)) error.exitCode = exitCode;
  return error; // Deliberately no cause, argv, executable, stdout or stderr.
}

// Windows has no POSIX process groups. Start suspended, assign a private Job Object,
// then resume: even an immediately exiting parent cannot orphan its children.
// This is a fixed supervisor, not a shell command assembled from user arguments.
// Killing the supervisor closes the sole Job handle (KILL_ON_JOB_CLOSE).
const WINDOWS_HOST = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class KernelProcessHost {
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic basic; public IO io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j,int c,ref Limits l,uint n);
 [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr a,IntPtr b,bool inherit,uint flags,IntPtr env,string cwd,ref Startup s,out Info i);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr p,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p,out uint c);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint c);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
 static string Quote(string s) {
   var b=new StringBuilder("\""); int slashes=0;
   foreach(char c in s) {
     if(c=='\\') { slashes++; continue; }
     if(c=='"') { b.Append('\\',slashes*2+1); b.Append(c); }
     else { b.Append('\\',slashes); b.Append(c); }
     slashes=0;
   }
   b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
 }
 public static int Run(string exe,string[] args) {
   IntPtr job=CreateJobObject(IntPtr.Zero,null); Info info=new Info();
   if(job==IntPtr.Zero) return 125;
   try {
     var limits=new Limits(); limits.basic.flags=0x2000;
     if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) return 125;
     var command=new StringBuilder(Quote(exe)); foreach(var arg in args) command.Append(" ").Append(Quote(arg));
     var s=new Startup(); s.cb=(uint)Marshal.SizeOf(s); s.flags=0x100;
     s.input=GetStdHandle(-10); s.output=GetStdHandle(-11); s.error=GetStdHandle(-12);
     if(!CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x08000000,IntPtr.Zero,null,ref s,out info)) return 125;
     if(!AssignProcessToJobObject(job,info.process)) { TerminateProcess(info.process,125); WaitForSingleObject(info.process,5000); return 125; }
     if(ResumeThread(info.thread)==0xffffffff) return 125;
     if(WaitForSingleObject(info.process,0xffffffff)!=0) return 125;
     uint code; return GetExitCodeProcess(info.process,out code) ? unchecked((int)code) : 125;
   } finally {
     CloseHandle(job);
     if(info.thread!=IntPtr.Zero) CloseHandle(info.thread);
     if(info.process!=IntPtr.Zero) CloseHandle(info.process);
   }
 }
}
'@
$spec = $env:FNOS_KERNEL_PROCESS_SPEC | ConvertFrom-Json
Remove-Item Env:FNOS_KERNEL_PROCESS_SPEC
$rc = [KernelProcessHost]::Run([string]$spec.executable, [string[]]$spec.args)
exit $rc
} catch { exit 125 }
`;

/**
 * onLine(text, stream) is synchronous; stream is "stdout" or "stderr".
 * Returned output is NOT redacted: callers must never persist it without filtering.
 * maxBuffer is a combined stdout/stderr byte budget (default 8 MiB). Overflow
 * aborts, rather than keeping an unbounded stream or silently accepting truncation.
 */
export function runKernelProcess(executable, args, { cwd, env, signal,
  timeoutMs = 30 * 60 * 1000, onLine = () => {}, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof executable !== "string" || !executable || executable.includes("\0") ||
        !Array.isArray(args) || args.some(x => typeof x !== "string" || x.includes("\0")) ||
        typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof env !== "object" || !env ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 ||
        !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 64 * 1024 * 1024 ||
        typeof onLine !== "function" || (signal && typeof signal.addEventListener !== "function")) {
      reject(failure("process-options")); return;
    }
    if (signal?.aborted) { reject(failure("process-aborted")); return; }
    let child, timer, killTimer, drainTimer, error, settled = false, closed = false;
    let groupReleased = false, stopping = false, exitCode, bytes = 0;
    const output = { stdout: [], stderr: [] };
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const pending = { stdout: "", stderr: "" }, omitted = { stdout: false, stderr: false };
    function groupSignal(value) {
      if (!child?.pid || groupReleased) return;
      try { process.kill(-child.pid, value); }
      catch (e) {
        if (e.code === "ESRCH") groupReleased = true;
        else error = failure("process-cleanup");
      }
    }
    function finish() {
      if (settled || !closed || killTimer) return;
      settled = true;
      clearTimeout(timer); clearTimeout(drainTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (exitCode !== 0) reject(failure("process-exit", exitCode));
      else resolve({ stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"), code: 0 });
    }
    function stop(reason) {
      if (reason && !error) error = failure(reason);
      if (stopping) return;
      stopping = true;
      if (process.platform === "win32") {
        // Terminating this owned supervisor closes its private Job Object.
        if (child?.pid && child.exitCode === null) child.kill();
      } else {
        groupSignal("SIGTERM");
        if (!groupReleased && child?.pid) {
          killTimer = setTimeout(() => {
            groupSignal("SIGKILL");
            killTimer = null;
            finish();
          }, 500);
        }
      }
      // Inherited pipes must not hold the Promise forever, including escaped
      // descendants. Escaping a POSIX session is outside this runner's ownership.
      drainTimer = setTimeout(() => {
        if (!closed) {
          error = failure("process-cleanup");
          child?.stdout?.destroy(); child?.stderr?.destroy();
          closed = true;
        }
        finish();
      }, 3000);
      finish();
    }
    function abort() { stop("process-aborted"); }
    function emit(text, stream) {
      if (error) return;
      try {
        const result = onLine(text, stream);
        if (result && typeof result.then === "function") result.catch(() => stop("process-log-failed"));
      } catch { stop("process-log-failed"); }
    }
    function lines(text, stream, final = false) {
      for (const part of text.split(/(?<=[\r\n])/)) {
        const end = /[\r\n]$/.test(part);
        if (!omitted[stream]) {
          pending[stream] += end ? part.slice(0, -1) : part;
          if (Buffer.byteLength(pending[stream]) > 16384) {
            pending[stream] = ""; omitted[stream] = true;
          }
        }
        if (end) {
          if (omitted[stream]) emit("[oversized output line omitted]", stream);
          else if (pending[stream]) emit(pending[stream], stream);
          pending[stream] = ""; omitted[stream] = false;
        }
      }
      if (final && (pending[stream] || omitted[stream])) {
        emit(omitted[stream] ? "[oversized output line omitted]" : pending[stream], stream);
        pending[stream] = ""; omitted[stream] = false;
      }
    }
    try {
      const windows = process.platform === "win32";
      const host = windows ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : executable;
      const argv = windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(WINDOWS_HOST, "utf16le").toString("base64")] : args;
      child = spawn(host, argv, { cwd, env: windows ? { ...env,
        FNOS_KERNEL_PROCESS_SPEC: JSON.stringify({ executable, args }) } : env,
      shell: false, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch { reject(failure("process-spawn")); return; }
    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", chunk => {
        bytes += chunk.length;
        if (bytes > maxBuffer) { stop("process-output-limit"); return; }
        if (!error) { output[stream].push(chunk); lines(decoders[stream].write(chunk), stream); }
      });
      child[stream].on("end", () => lines(decoders[stream].end(), stream, true));
      child[stream].on("error", () => stop("process-cleanup"));
    }
    child.on("error", () => { error = failure("process-spawn"); stop(); });
    child.on("exit", code => { exitCode = code; stop(); });
    child.on("close", code => { exitCode = code; closed = true; finish(); });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop("process-timeout"), timeoutMs);
    if (signal?.aborted) abort();
  });
}
