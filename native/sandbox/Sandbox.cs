// Windows write-restricted token runner, compiled with the in-box .NET Framework csc (C# 5).
//   run    --cap <SID> [--extra-restrict <SID>]... --cwd <dir> --cmdline <command line> [--parent <pid>]
//   run    --mode direct --cwd <dir> --cmdline <command line> [--parent <pid>]   (same user token, no restriction)
// In both modes the command runs inside a kill-on-close Job Object, and the job is terminated when the command
// exits or when the --parent process (the Agent Host) exits, so a killed Host cannot leave a shell tree behind.
//   grant  --cap <SID> --path <dir>
//   revoke --cap <SID> --path <dir>
// A restricted command runs at Low integrity. Everyone has to stay a restricting SID because device objects such as NUL
// and the console grant write access only to Everyone, and that alone would also open every Everyone-writable file.
// Mandatory integrity closes the gap: a Low token cannot write a file without a Low label, whatever its DACL says, so a
// grant is the capability ACE plus an inheritable Low label, and revoke removes both.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class Native
{
    public const uint DISABLE_MAX_PRIVILEGE = 0x1, WRITE_RESTRICTED = 0x8;
    public const uint TOKEN_ASSIGN_PRIMARY = 0x1, TOKEN_DUPLICATE = 0x2, TOKEN_QUERY = 0x8, TOKEN_ADJUST_DEFAULT = 0x80;
    public const uint SYNCHRONIZE = 0x00100000;
    public const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000;
    public const uint STARTF_USESTDHANDLES = 0x100;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    public const int TokenDefaultDacl = 6, TokenIntegrityLevel = 25, SE_FILE_OBJECT = 1;
    public const uint SE_GROUP_INTEGRITY = 0x20, LABEL_SECURITY_INFORMATION = 0x10;

    [StructLayout(LayoutKind.Sequential)] public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] public struct TOKEN_DEFAULT_DACL { public IntPtr DefaultDacl; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint nDisable, IntPtr disable, uint nDelete, IntPtr delete, uint nRestrict, SID_AND_ATTRIBUTES[] restrict, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetTokenInformation(IntPtr token, int cls, IntPtr info, int len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr sd, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    public static extern uint SetNamedSecurityInfoW(string path, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessAsUserW(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint ms);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}

static class Program
{
    static int Main(string[] argv)
    {
        try
        {
            if (argv.Length == 0) return Fail("missing command");
            var opts = new Dictionary<string, List<string>>();
            for (int i = 1; i + 1 < argv.Length; i += 2)
            {
                string k = argv[i];
                if (!k.StartsWith("--")) return Fail("bad option " + k);
                List<string> list;
                if (!opts.TryGetValue(k, out list)) opts[k] = list = new List<string>();
                list.Add(argv[i + 1]);
            }
            switch (argv[0])
            {
                case "run": return Run(opts);
                case "grant": return Acl(opts, true);
                case "revoke": return Acl(opts, false);
                default: return Fail("unknown command " + argv[0]);
            }
        }
        catch (Exception e) { return Fail(e.Message); }
    }

    static int Fail(string message) { Console.Error.WriteLine("sandbox: " + message); return 125; }
    static string One(Dictionary<string, List<string>> o, string k)
    {
        List<string> v; if (!o.TryGetValue(k, out v)) throw new ArgumentException("missing " + k); return v[0];
    }

    static int Acl(Dictionary<string, List<string>> o, bool grant)
    {
        var sid = new SecurityIdentifier(One(o, "--cap"));
        string path = One(o, "--path");
        const InheritanceFlags tree = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        // Changing a label needs WRITE_OWNER, which an owner does not hold implicitly (on a typical E:\ tree only
        // Authenticated Users: Modify applies). OWNER RIGHTS keeps the owner's implicit rights and adds just that.
        var ownerRights = new SecurityIdentifier("S-1-3-4");
        var security = Directory.GetAccessControl(path, AccessControlSections.Access);
        security.AddAccessRule(new FileSystemAccessRule(ownerRights,
            FileSystemRights.ReadPermissions | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership, tree, PropagationFlags.None, AccessControlType.Allow));
        if (grant) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.Modify, tree, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(path, security);
        SetLabel(path, grant ? "S:(ML;OICI;NW;;;LW)" : "S:");
        if (grant) return 0;
        security.PurgeAccessRules(sid);
        security.PurgeAccessRules(ownerRights);
        Directory.SetAccessControl(path, security);
        return 0;
    }

    // Propagates through the existing tree: files already under a root become writable, and revoke clears them again.
    static void SetLabel(string path, string sddl)
    {
        IntPtr sd, sacl; uint size; bool present, defaulted;
        if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size)) throw new Win32Exception();
        if (!Native.GetSecurityDescriptorSacl(sd, out present, out sacl, out defaulted)) throw new Win32Exception();
        uint error = Native.SetNamedSecurityInfoW(path, Native.SE_FILE_OBJECT, Native.LABEL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
        if (error != 0) throw new Win32Exception((int)error);
    }

    static IntPtr Sid(string text)
    {
        IntPtr sid;
        if (!Native.ConvertStringSidToSid(text, out sid)) throw new Win32Exception();
        return sid;
    }

    static int Run(Dictionary<string, List<string>> o)
    {
        string cwd = One(o, "--cwd"), cmdline = One(o, "--cmdline");
        List<string> mode; bool direct = o.TryGetValue("--mode", out mode) && mode[0] == "direct";

        IntPtr own;
        if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_DUPLICATE | Native.TOKEN_QUERY | Native.TOKEN_ASSIGN_PRIMARY | Native.TOKEN_ADJUST_DEFAULT, out own))
            throw new Win32Exception();
        IntPtr token = own;
        if (!direct)
        {
            string cap = One(o, "--cap");
            var restrict = new List<string>(); restrict.Add(cap);
            List<string> extra; if (o.TryGetValue("--extra-restrict", out extra)) restrict.AddRange(extra);
            var sids = new Native.SID_AND_ATTRIBUTES[restrict.Count];
            for (int i = 0; i < sids.Length; i++) sids[i].Sid = Sid(restrict[i]);
            if (!Native.CreateRestrictedToken(own, Native.DISABLE_MAX_PRIVILEGE | Native.WRITE_RESTRICTED, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)sids.Length, sids, out token))
                throw new Win32Exception();

            // Objects the child creates (pipes, events) must be openable by the restricting SID too.
            var dacl = new DiscretionaryAcl(false, false, 3);
            dacl.AddAccess(AccessControlType.Allow, new SecurityIdentifier(cap), 0x10000000, InheritanceFlags.None, PropagationFlags.None);
            dacl.AddAccess(AccessControlType.Allow, WindowsIdentity.GetCurrent().User, 0x10000000, InheritanceFlags.None, PropagationFlags.None);
            dacl.AddAccess(AccessControlType.Allow, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), 0x10000000, InheritanceFlags.None, PropagationFlags.None);
            byte[] bin = new byte[dacl.BinaryLength]; dacl.GetBinaryForm(bin, 0);
            IntPtr aclMem = Marshal.AllocHGlobal(bin.Length); Marshal.Copy(bin, 0, aclMem, bin.Length);
            IntPtr info = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(info, aclMem);
            if (!Native.SetTokenInformation(token, Native.TokenDefaultDacl, info, IntPtr.Size)) throw new Win32Exception();

            var low = new Native.SID_AND_ATTRIBUTES { Sid = Sid("S-1-16-4096"), Attributes = Native.SE_GROUP_INTEGRITY };
            int labelSize = Marshal.SizeOf(low);
            IntPtr label = Marshal.AllocHGlobal(labelSize); Marshal.StructureToPtr(low, label, false);
            if (!Native.SetTokenInformation(token, Native.TokenIntegrityLevel, label, labelSize)) throw new Win32Exception();
        }

        IntPtr job = Native.CreateJobObjectW(IntPtr.Zero, null);
        var limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.Basic.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception();

        var si = new Native.STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.dwFlags = (int)Native.STARTF_USESTDHANDLES;
        si.hStdInput = Native.GetStdHandle(Native.STD_INPUT_HANDLE);
        si.hStdOutput = Native.GetStdHandle(Native.STD_OUTPUT_HANDLE);
        si.hStdError = Native.GetStdHandle(Native.STD_ERROR_HANDLE);
        Native.PROCESS_INFORMATION pi;
        if (!Native.CreateProcessAsUserW(token, null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, true,
            Native.CREATE_SUSPENDED | Native.CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi))
            throw new Win32Exception();
        if (!Native.AssignProcessToJobObject(job, pi.hProcess)) { int e = Marshal.GetLastWin32Error(); Native.TerminateJobObject(job, 1); throw new Win32Exception(e); }
        Native.ResumeThread(pi.hThread);

        // Wait for the command, and also for the Host: if the Host dies first the whole job is terminated.
        var waits = new List<IntPtr>(); waits.Add(pi.hProcess);
        List<string> parent;
        if (o.TryGetValue("--parent", out parent))
        {
            IntPtr host = Native.OpenProcess(Native.SYNCHRONIZE, false, int.Parse(parent[0]));
            if (host == IntPtr.Zero) { Native.TerminateJobObject(job, 1); return 1; } // the Host is already gone
            waits.Add(host);
        }
        if (Native.WaitForMultipleObjects((uint)waits.Count, waits.ToArray(), false, 0xFFFFFFFF) == 1) { Native.TerminateJobObject(job, 1); return 1; }
        uint code; Native.GetExitCodeProcess(pi.hProcess, out code);
        Native.TerminateJobObject(job, 1); // descendants must not outlive the command
        return unchecked((int)code);
    }
}
