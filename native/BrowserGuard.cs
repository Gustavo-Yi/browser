// Per-browser Windows job owner. No service, startup entry, injection, or global policy.
// Build with the Windows .NET Framework compiler; all handles are non-inheritable.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class BrowserGuard {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic; public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long a,b,c,d; public uint faults,total,active,terminated;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int cb; public string reserved, desktop, title;
        public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
        public short show, reservedSize; public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimit info, int length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, int length, IntPtr resultLength);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string exe, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo info, out ProcessInfo process);
    static IntPtr job;
    static readonly List<IntPtr> adoptedJobs = new List<IntPtr>();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly object OutputLock = new object();
    static void Send(object value) { lock(OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
    static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slash = 0;
        foreach (char c in value) {
            if (c == '\\') { slash++; continue; }
            result.Append('\\', c == '"' ? slash * 2 + 1 : slash); result.Append(c); slash = 0;
        }
        return result.Append('\\', slash * 2).Append('"').ToString();
    }
    static uint Active(IntPtr handle) {
        Accounting info;
        Check(QueryInformationJobObject(handle, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return info.active;
    }
    static uint Active() { uint count = Active(job); foreach (IntPtr extra in adoptedJobs) count += Active(extra); return count; }
    static IntPtr NewJob() {
        IntPtr handle = CreateJobObject(IntPtr.Zero, null); Check(handle != IntPtr.Zero);
        var limits = new ExtendedLimit(); limits.Basic.LimitFlags = 0x2000;
        try { Check(SetInformationJobObject(handle, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimit)))); return handle; }
        catch { CloseHandle(handle); throw; }
    }
    static DateTime Birth(IntPtr handle) {
        long c,e,k,u; Check(GetProcessTimes(handle, out c, out e, out k, out u)); return DateTime.FromFileTimeUtc(c);
    }
    static uint Launch(Dictionary<string, object> request) {
        string exe = (string)request["exe"];
        if (!String.Equals(Path.GetFileName(exe), "chrome.exe", StringComparison.OrdinalIgnoreCase) || !Path.IsPathRooted(exe)) throw new Exception("Expected an absolute chrome.exe path");
        var command = new StringBuilder(Quote(exe));
        foreach (object arg in (System.Collections.ArrayList)request["args"]) command.Append(' ').Append(Quote((string)arg));
        var startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo));
        ProcessInfo child;
        // CREATE_SUSPENDED | CREATE_NO_WINDOW: assign BEFORE Chrome can create children.
        Check(CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, Path.GetDirectoryName(exe), ref startup, out child));
        try {
            try { Check(AssignProcessToJobObject(job, child.process)); Check(ResumeThread(child.thread) != UInt32.MaxValue); }
            catch { TerminateProcess(child.process, 1); throw; }
            return child.pid;
        } finally { CloseHandle(child.thread); CloseHandle(child.process); }
    }
    static uint Adopt(Dictionary<string, object> request) {
        int pid = Convert.ToInt32(request["pid"]);
        // Holding the process handle prevents PID reuse between validation and assignment.
        IntPtr handle = OpenProcess(0x101101, false, pid); Check(handle != IntPtr.Zero);
        try {
            using (var row = new ManagementObject("Win32_Process.Handle='" + pid + "'")) {
                row.Get();
                string exe = (string)row["ExecutablePath"];
                DateTime created = ManagementDateTimeConverter.ToDateTime((string)row["CreationDate"]).ToUniversalTime();
                if (!String.Equals(exe, (string)request["executable"], StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals(Path.GetFileName(exe), "chrome.exe", StringComparison.OrdinalIgnoreCase) ||
                    (string)row["CommandLine"] != (string)request["commandLine"] ||
                    created.ToString("o") != (string)request["createdAt"] ||
                    Math.Abs((Birth(handle) - created).TotalMilliseconds) > 1 || WaitForSingleObject(handle, 0) == 0)
                    throw new Exception("Browser identity changed; not adopted");
                Check(AssignProcessToJobObject(job, handle));
                // Existing Chrome children predate assignment. Attach only descendants of
                // the validated root, never all chrome.exe processes or unrelated profiles.
                var parents = new Dictionary<int, DateTime>(); parents.Add(pid, Birth(handle));
                using (var search = new ManagementObjectSearcher("SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process"))
                using (var rows = search.Get()) {
                    bool changed;
                    do {
                        changed = false;
                        foreach (ManagementObject child in rows) {
                            int id = Convert.ToInt32(child["ProcessId"]), parent = Convert.ToInt32(child["ParentProcessId"]);
                            if (parents.ContainsKey(id) || !parents.ContainsKey(parent)) continue;
                            DateTime birth = ManagementDateTimeConverter.ToDateTime((string)child["CreationDate"]).ToUniversalTime();
                            if (birth < parents[parent].AddMilliseconds(-1)) continue;
                            try {
                                IntPtr childHandle = OpenProcess(0x101101, false, id);
                                if (childHandle == IntPtr.Zero) { if (Marshal.GetLastWin32Error() == 87) continue; Check(false); }
                                try {
                                    if (WaitForSingleObject(childHandle, 0) == 0 || Math.Abs((Birth(childHandle) - birth).TotalMilliseconds) > 1) continue;
                                    // An existing sandbox job can only nest under a compatible
                                    // NEW empty job, not the already populated browser job.
                                    IntPtr extra = NewJob(); adoptedJobs.Add(extra);
                                    Check(AssignProcessToJobObject(extra, childHandle));
                                } finally { CloseHandle(childHandle); }
                                parents.Add(id, birth); changed = true;
                            } catch (ArgumentException) { /* child already exited */ }
                        }
                    } while (changed);
                }
            }
        } catch {
            // Adoption must never kill existing user browsers on a partial failure.
            var limits = new ExtendedLimit();
            SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimit)));
            foreach (IntPtr extra in adoptedJobs) SetInformationJobObject(extra, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimit)));
            throw;
        } finally { CloseHandle(handle); }
        return (uint)pid;
    }
    static int Main(string[] args) {
        try {
            Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
            using (var owner = Process.GetProcessById(Int32.Parse(args[0]))) {
                IntPtr ownerHandle = owner.Handle;
                var ownerWatch = new Thread(() => { WaitForSingleObject(ownerHandle, UInt32.MaxValue); Environment.Exit(0); });
                ownerWatch.IsBackground = true; ownerWatch.Start();
                string first = Console.ReadLine(); if (first == null || owner.HasExited) return 0;
                var request = Json.Deserialize<Dictionary<string, object>>(first);
                job = NewJob(); // KILL_ON_JOB_CLOSE, no breakaway
                uint pid = (string)request["mode"] == "adopt" ? Adopt(request) : Launch(request);
                Send(new { type = "spawn", pid = pid });
                var input = new Thread(() => {
                    try {
                        string line;
                        while ((line = Console.ReadLine()) != null) {
                            if (line == "force") { Check(TerminateJobObject(job, 1)); foreach (IntPtr extra in adoptedJobs) Check(TerminateJobObject(extra, 1)); }
                        }
                    } finally { Environment.Exit(0); } // broken owner pipe: job handles close
                });
                input.IsBackground = true; input.Start();
                while (Active() != 0) Thread.Sleep(100);
                Send(new { type = "exit" });
            }
            return 0;
        } catch (Exception error) { try { Send(new { type = "error", message = error.Message }); } catch {} return 1; }
        finally { if (job != IntPtr.Zero) CloseHandle(job); foreach (IntPtr extra in adoptedJobs) CloseHandle(extra); }
    }
}
