// Read-only Core Audio metadata. No IAudioClient, audio buffers, amplitude meter, or UI inspection.
// Interface IDs/vtable order follow Microsoft's mmdeviceapi.h and audiopolicy.h.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Globalization;
using System.Security.Principal;

namespace Watson.WindowsActivity {
  public sealed class ActivityRow {
    public uint pid { get; set; }
    public uint ownerPid { get; set; }
    public string executable { get; set; }
    public string ownerExecutable { get; set; }
    public string flow { get; set; }
    public string state { get; set; }
    public bool singleProcess { get; set; }
  }
  public sealed class ActivitySnapshot {
    public string type { get; set; }
    public int protocol { get; set; }
    public string requestId { get; set; }
    public string checkedAt { get; set; }
    public List<ActivityRow> sessions { get; set; }
    public List<string> errors { get; set; }
    public ActivitySnapshot(string id) {
      type = "activity"; protocol = 1; requestId = id;
      checkedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
      sessions = new List<ActivityRow>(); errors = new List<string>();
    }
    internal void Error(string message) {
      if (errors.Count < 64 && !errors.Contains(message)) errors.Add(message.Length > 2000 ? message.Substring(0, 2000) : message);
    }
  }
  enum AudioState { Inactive = 0, Active = 1, Expired = 2 }
  enum DataFlow { Render = 0, Capture = 1, All = 2 }
  sealed class CoreAudioMetadataException : InvalidOperationException { internal CoreAudioMetadataException(string message) : base(message) { } }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumeratorObject { }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDeviceEnumerator { [PreserveSig] int EnumAudioEndpoints(DataFlow flow, uint mask, out IDeviceCollection devices); }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDevice {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
    [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out uint state);
  }
  [ComImport, Guid("1BE09788-6894-4089-8586-9A2A6C265AC5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IEndpoint { [PreserveSig] int GetDataFlow(out DataFlow flow); }
  [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ISessionControl { [PreserveSig] int GetState(out int state); }
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISessionControl2 {
    [PreserveSig] int GetState(out AudioState state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint processId);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out ISessionControl control);
  }
  [Guid("641DD20B-4D41-49CC-ABA3-174B9477BB08"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComVisible(true)]
  public interface ISessionNotification {
    [PreserveSig] int OnSessionCreated([MarshalAs(UnmanagedType.Interface)] ISessionControl control);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr session, uint flags, out ISessionControl control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr session, uint flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out ISessionEnumerator enumerator);
    [PreserveSig] int RegisterSessionNotification(ISessionNotification notification);
    [PreserveSig] int UnregisterSessionNotification(ISessionNotification notification);
  }

  static class Native {
    [DllImport("ole32.dll")] internal static extern int CoInitializeEx(IntPtr reserved, uint mode);
    [DllImport("ole32.dll")] internal static extern void CoUninitialize();
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
    internal static void Check(int status, string operation) { if (status < 0) throw new CoreAudioMetadataException(operation + " failed (HRESULT 0x" + status.ToString("X8") + ")"); }
    internal static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }
  }
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low; public uint high; public ulong Value { get { return ((ulong)high << 32) | low; } } }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessEntry {
    public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parentPid; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable;
  }
  sealed class VerifiedProcess { internal uint pid; internal string executable, userSid; internal ulong created; }
  sealed class ProcessCatalog {
    readonly Dictionary<uint, ProcessEntry> entries = new Dictionary<uint, ProcessEntry>();
    readonly Dictionary<uint, VerifiedProcess> verified = new Dictionary<uint, VerifiedProcess>();
    readonly HashSet<uint> excludedPids; readonly HashSet<string> excludedNames;
    readonly uint currentSessionId; readonly string currentUserSid;
    internal bool Contains(uint pid) { return entries.ContainsKey(pid); }
    internal ProcessCatalog(uint[] excluded, string[] excludedExecutables) {
      excludedPids = new HashSet<uint>(excluded); excludedNames = new HashSet<string>(excludedExecutables, StringComparer.OrdinalIgnoreCase);
      if (!Native.ProcessIdToSessionId(Native.GetCurrentProcessId(), out currentSessionId)) throw new InvalidOperationException("The current Windows desktop session could not be identified");
      using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
        if (identity.User == null) throw new InvalidOperationException("The current Windows user could not be identified");
        currentUserSid = identity.User.Value;
      }
      IntPtr snapshot = Native.CreateToolhelp32Snapshot(2, 0);
      if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("Windows process metadata enumeration failed");
      try {
        ProcessEntry entry = new ProcessEntry(); entry.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
        if (!Native.Process32FirstW(snapshot, ref entry)) throw new InvalidOperationException("Windows process metadata enumeration returned no entries");
        do { entries[entry.pid] = entry; entry.size = (uint)Marshal.SizeOf(typeof(ProcessEntry)); } while (Native.Process32NextW(snapshot, ref entry));
        if (Marshal.GetLastWin32Error() != 18) throw new InvalidOperationException("Windows process metadata enumeration was incomplete");
      } finally { Native.CloseHandle(snapshot); }
    }
    VerifiedProcess Verify(ProcessEntry entry) {
      VerifiedProcess existing; if (verified.TryGetValue(entry.pid, out existing)) return existing;
      IntPtr process = Native.OpenProcess(0x1000, false, entry.pid);
      if (process == IntPtr.Zero) throw new InvalidOperationException("An approved audio process could not be identified");
      try {
        StringBuilder path = new StringBuilder(32768); int size = path.Capacity; FileTime creation, exit, kernel, user;
        if (!Native.QueryFullProcessImageNameW(process, 0, path, ref size) || !Native.GetProcessTimes(process, out creation, out exit, out kernel, out user)) throw new InvalidOperationException("An approved audio process identity could not be verified");
        string name = Path.GetFileName(path.ToString());
        if (!String.Equals(name, entry.executable, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("An audio process changed identity during the scan");
        IntPtr token;
        if (!Native.OpenProcessToken(process, 8, out token)) throw new InvalidOperationException("An approved audio process user could not be verified");
        string userSid;
        try { using (WindowsIdentity identity = new WindowsIdentity(token)) { if (identity.User == null) throw new InvalidOperationException("An approved audio process user is unavailable"); userSid = identity.User.Value; } }
        finally { Native.CloseHandle(token); }
        existing = new VerifiedProcess(); existing.pid = entry.pid; existing.executable = name; existing.created = creation.Value; existing.userSid = userSid; verified[entry.pid] = existing; return existing;
      } finally { Native.CloseHandle(process); }
    }
    internal VerifiedProcess FindOwner(uint audioPid, HashSet<string> allowed, HashSet<string> browsers, out VerifiedProcess leaf) {
      leaf = null; List<ProcessEntry> chain = new List<ProcessEntry>(); HashSet<uint> seen = new HashSet<uint>(); uint current = audioPid;
      for (int depth = 0; current != 0 && depth < 32; depth++) {
        ProcessEntry entry; if (!entries.TryGetValue(current, out entry)) { if (depth == 0) throw new InvalidOperationException("An audio process disappeared during metadata collection"); break; }
        if (!seen.Add(current)) throw new InvalidOperationException("Windows audio process ancestry was inconsistent");
        chain.Add(entry); current = entry.parentPid;
      }
      if (chain.Count == 32 && current != 0) throw new InvalidOperationException("Windows audio process ancestry exceeded its bound");
      if (chain.Count == 0 || excludedPids.Contains(audioPid) || excludedNames.Contains(chain[0].executable)) return null;
      uint audioSessionId;
      if (!Native.ProcessIdToSessionId(audioPid, out audioSessionId)) throw new InvalidOperationException("An audio process desktop session could not be verified");
      if (audioSessionId != currentSessionId) return null;
      int selected = -1, browser = -1;
      for (int index = 0; index < chain.Count; index++) {
        if (excludedPids.Contains(chain[index].pid) || excludedNames.Contains(chain[index].executable)) { if (selected < 0 && browser < 0) return null; break; }
        if (!allowed.Contains(chain[index].executable)) continue;
        if (!browsers.Contains(chain[index].executable)) { selected = index; break; }
        if (browser < 0) browser = index;
      }
      if (selected < 0) selected = browser; if (selected < 0) return null;
      VerifiedProcess child = null, owner = null;
      for (int index = 0; index <= selected; index++) {
        VerifiedProcess actual = Verify(chain[index]);
        if (!String.Equals(actual.userSid, currentUserSid, StringComparison.Ordinal)) return null;
        if (child != null && actual.created > child.created) throw new InvalidOperationException("Windows audio process parent PID was reused");
        if (index == 0) leaf = actual; child = actual; owner = actual;
      }
      return owner;
    }
  }
  sealed class SessionLease : IDisposable {
    internal readonly ISessionControl2 control; readonly IntPtr ownedReference;
    internal VerifiedProcess lastLeaf, lastOwner;
    internal SessionLease(ISessionControl2 value) { control = value; ownedReference = Marshal.GetIUnknownForObject(value); }
    public void Dispose() { if (ownedReference != IntPtr.Zero) Marshal.Release(ownedReference); }
  }
  [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
  public sealed class SessionNotification : ISessionNotification {
    readonly EndpointWatch owner;
    internal SessionNotification(EndpointWatch value) { owner = value; }
    public int OnSessionCreated(ISessionControl control) { try { owner.Remember(control); } catch (Exception error) { owner.CallbackError(error.Message); } return 0; }
  }
  sealed class EndpointWatch : IDisposable {
    readonly object gate = new object(); readonly ISessionManager2 manager; readonly SessionNotification notification;
    readonly Dictionary<string, SessionLease> sessions = new Dictionary<string, SessionLease>(); readonly List<string> callbackErrors = new List<string>();
    readonly DataFlow flow; bool disposed; volatile bool unhealthy;
    internal bool Unhealthy { get { return unhealthy; } }
    internal EndpointWatch(IDevice device, DataFlow direction) {
      flow = direction; Guid iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"); object activated;
      Native.Check(device.Activate(ref iid, 23, IntPtr.Zero, out activated), "Core Audio session manager activation"); manager = (ISessionManager2)activated;
      notification = new SessionNotification(this);
      try { Native.Check(manager.RegisterSessionNotification(notification), "Core Audio session notification registration"); Seed(); }
      catch { Dispose(); throw; }
    }
    internal void CallbackError(string message) { lock (gate) { if (!disposed && callbackErrors.Count < 64) { callbackErrors.Add(message); unhealthy = true; } } }
    internal void Remember(ISessionControl incoming) {
      ISessionControl2 control = (ISessionControl2)incoming; string id;
      Native.Check(control.GetSessionInstanceIdentifier(out id), "Core Audio session instance identity");
      if (String.IsNullOrEmpty(id)) throw new InvalidOperationException("Core Audio returned an empty session instance identity");
      lock (gate) {
        if (disposed || sessions.ContainsKey(id)) return;
        if (sessions.Count >= 8192) throw new InvalidOperationException("Core Audio session tracking exceeded its bound");
        sessions[id] = new SessionLease(control);
      }
    }
    void Seed() {
      ISessionEnumerator enumerator = null;
      try {
        Native.Check(manager.GetSessionEnumerator(out enumerator), "Core Audio session enumeration"); int count;
        // GetCount enables new-session notification delivery after registration.
        Native.Check(enumerator.GetCount(out count), "Core Audio session count");
        if (count < 0 || count > 8192) throw new InvalidOperationException("Core Audio session enumeration exceeded its bound");
        for (int index = 0; index < count; index++) { ISessionControl control; Native.Check(enumerator.GetSession(index, out control), "Core Audio session access"); Remember(control); }
      } finally { Native.Release(enumerator); }
    }
    internal void Read(ActivitySnapshot result, ProcessCatalog processes, HashSet<string> allowed, HashSet<string> browsers) {
      try { Seed(); } catch (Exception error) { unhealthy = true; result.Error(error.Message); }
      List<KeyValuePair<string, SessionLease>> current;
      lock (gate) {
        foreach (string error in callbackErrors) result.Error(error); callbackErrors.Clear();
        current = new List<KeyValuePair<string, SessionLease>>(sessions);
      }
      // COM calls run outside the callback lock so notification delivery cannot deadlock a scan.
      List<KeyValuePair<string, SessionLease>> expired = new List<KeyValuePair<string, SessionLease>>();
      foreach (KeyValuePair<string, SessionLease> item in current) {
          try {
            ISessionControl2 control = item.Value.control; AudioState state;
            Native.Check(control.GetState(out state), "Core Audio session state");
            if (state == AudioState.Expired) { expired.Add(item); continue; }
            if (state != AudioState.Active && state != AudioState.Inactive) throw new InvalidOperationException("Core Audio returned an invalid session state");
            int systemSound = control.IsSystemSoundsSession(); Native.Check(systemSound, "Core Audio system-session classification"); if (systemSound == 0) continue;
            uint audioPid; int attribution = control.GetProcessId(out audioPid); Native.Check(attribution, "Core Audio session process identity");
            if (audioPid == 0) { if (state == AudioState.Active) result.Error("An active Windows audio session has no attributable process identity"); continue; }
            VerifiedProcess leaf, owner;
            if (state == AudioState.Inactive && !processes.Contains(audioPid)) {
              // Retired controls can outlive the process. Their confirmed inactive state
              // still describes released I/O; retain an already-verified session owner.
              leaf = item.Value.lastLeaf; owner = item.Value.lastOwner;
              if (leaf == null || owner == null || !allowed.Contains(owner.executable)) continue;
            } else {
              owner = processes.FindOwner(audioPid, allowed, browsers, out leaf); if (owner == null) continue;
              item.Value.lastLeaf = leaf; item.Value.lastOwner = owner;
            }
            if (result.sessions.Count >= 4096) { result.Error("Core Audio activity results exceeded their bound"); break; }
            ActivityRow row = new ActivityRow(); row.pid = audioPid; row.ownerPid = owner.pid; row.executable = leaf.executable; row.ownerExecutable = owner.executable;
            row.flow = flow == DataFlow.Capture ? "capture" : "render"; row.state = state == AudioState.Active ? "active" : "inactive"; row.singleProcess = attribution == 0;
            result.sessions.Add(row);
          } catch (Exception error) { if (error is CoreAudioMetadataException) unhealthy = true; result.Error(error.Message); }
      }
      lock (gate) {
        foreach (KeyValuePair<string, SessionLease> item in expired) {
          SessionLease value; if (sessions.TryGetValue(item.Key, out value) && Object.ReferenceEquals(value, item.Value)) { value.Dispose(); sessions.Remove(item.Key); }
        }
      }
    }
    public void Dispose() {
      lock (gate) { if (disposed) return; disposed = true; }
      // Unregister outside the lock; a concurrent callback may need that lock to return.
      try { manager.UnregisterSessionNotification(notification); } catch { }
      lock (gate) { foreach (SessionLease item in sessions.Values) item.Dispose(); sessions.Clear(); }
      Native.Release(manager);
    }
  }
  sealed class ScanRequest {
    internal string id; internal string[] allowed, browsers, excludedNames; internal uint[] excludedPids;
    internal readonly TaskCompletionSource<ActivitySnapshot> completed = new TaskCompletionSource<ActivitySnapshot>();
  }
  sealed class MetadataMonitor : IDisposable {
    readonly BlockingCollection<ScanRequest> requests = new BlockingCollection<ScanRequest>(1);
    readonly Thread thread; volatile string failure;
    internal MetadataMonitor() { thread = new Thread(Run); thread.IsBackground = true; thread.SetApartmentState(ApartmentState.MTA); thread.Start(); }
    internal ActivitySnapshot Read(string id, string[] allowed, string[] browsers, uint[] excludedPids, string[] excludedNames) {
      if (failure != null) throw new InvalidOperationException(failure);
      ScanRequest request = new ScanRequest(); request.id = id; request.allowed = allowed; request.browsers = browsers; request.excludedPids = excludedPids; request.excludedNames = excludedNames;
      if (!requests.TryAdd(request)) throw new InvalidOperationException("A Core Audio metadata scan is already pending");
      if (!request.completed.Task.Wait(10000)) throw new TimeoutException("Core Audio metadata scan timed out");
      return request.completed.Task.Result;
    }
    void Run() {
      IDeviceEnumerator enumerator = null; Dictionary<string, EndpointWatch> endpoints = new Dictionary<string, EndpointWatch>(); bool initialized = false;
      try {
        Native.Check(Native.CoInitializeEx(IntPtr.Zero, 0), "Core Audio MTA COM initialization"); initialized = true;
        enumerator = (IDeviceEnumerator)new DeviceEnumeratorObject();
        foreach (ScanRequest request in requests.GetConsumingEnumerable()) {
          ActivitySnapshot result = new ActivitySnapshot(request.id);
          try {
            HashSet<string> allowed = new HashSet<string>(request.allowed, StringComparer.OrdinalIgnoreCase), browsers = new HashSet<string>(request.browsers, StringComparer.OrdinalIgnoreCase);
            ProcessCatalog processCatalog = new ProcessCatalog(request.excludedPids, request.excludedNames);
            IDeviceCollection devices = null; HashSet<string> present = new HashSet<string>(); bool complete = true;
            try {
              // DEVICE_STATE_ACTIVE: connected, enabled endpoints; both capture and render flows.
              Native.Check(enumerator.EnumAudioEndpoints(DataFlow.All, 1, out devices), "Core Audio endpoint enumeration"); uint count;
              Native.Check(devices.GetCount(out count), "Core Audio endpoint count"); if (count > 128) throw new InvalidOperationException("Core Audio endpoint count exceeded its bound");
              for (uint index = 0; index < count; index++) {
                IDevice device = null;
                try {
                  Native.Check(devices.Item(index, out device), "Core Audio endpoint access"); string id; DataFlow flow;
                  Native.Check(device.GetId(out id), "Core Audio endpoint identity"); Native.Check(((IEndpoint)device).GetDataFlow(out flow), "Core Audio endpoint direction");
                  if (flow != DataFlow.Capture && flow != DataFlow.Render) throw new InvalidOperationException("Core Audio returned an invalid endpoint direction");
                  present.Add(id);
                  EndpointWatch previous;
                  if (endpoints.TryGetValue(id, out previous) && previous.Unhealthy) { previous.Dispose(); endpoints.Remove(id); }
                  if (!endpoints.ContainsKey(id)) endpoints[id] = new EndpointWatch(device, flow);
                } catch (Exception error) { complete = false; result.Error(error.Message); }
                finally { Native.Release(device); }
              }
            } catch (Exception error) { complete = false; result.Error(error.Message); }
            finally { Native.Release(devices); }
            if (complete) {
              List<string> removed = new List<string>(); foreach (string id in endpoints.Keys) if (!present.Contains(id)) removed.Add(id);
              foreach (string id in removed) { endpoints[id].Dispose(); endpoints.Remove(id); }
            }
            foreach (EndpointWatch endpoint in endpoints.Values) endpoint.Read(result, processCatalog, allowed, browsers);
          } catch (Exception error) { result.Error(error.Message); }
          result.checkedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture); request.completed.SetResult(result);
        }
      } catch (Exception error) {
        failure = error.Message; ScanRequest pending;
        while (requests.TryTake(out pending)) { ActivitySnapshot result = new ActivitySnapshot(pending.id); result.Error(failure); pending.completed.SetResult(result); }
      } finally {
        foreach (EndpointWatch endpoint in endpoints.Values) endpoint.Dispose(); Native.Release(enumerator); if (initialized) Native.CoUninitialize();
      }
    }
    public void Dispose() { requests.CompleteAdding(); thread.Join(1500); }
  }
  public static class CoreAudioActivity {
    static MetadataMonitor monitor;
    public static void Initialize() { if (monitor == null) monitor = new MetadataMonitor(); }
    public static ActivitySnapshot Read(string id, string[] allowedExecutables, string[] browsers, uint[] excludedPids, string[] excludedExecutables) {
      Initialize(); return monitor.Read(id, allowedExecutables, browsers, excludedPids, excludedExecutables);
    }
    public static void Shutdown() { if (monitor != null) { monitor.Dispose(); monitor = null; } }
  }
}
