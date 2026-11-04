// rc-audio: captures Marvel Rivals' sound and your mic for Rivals Clipper's local recorder.
//
//   rc-audio.exe list
//       Prints JSON: capture (mic) and render devices, and whether per-app capture is available.
//   rc-audio.exe capture [--game-pid <pid>] [--game-loopback] [--mic <device id>|default] [--no-game]
//       Writes timestamped PCM chunks to stdout (format below) and JSON status lines to stderr.
//       Track 0 = game, track 1 = mic. Stops when stdin closes, so it never outlives the app.
//
// Game sound uses Windows' per-process loopback (Windows 10 build 20348+ / Windows 11), which records
// only the game's own audio, not Discord or music. It does not touch the game process: Windows' audio
// engine hands us a copy of the game's output, the same way OBS's "Application Audio Capture" works.
// If per-process capture is unavailable it falls back to everything playing on the default speakers.
//
// Every track is written continuously (silence is filled in when nothing plays), and every chunk is
// stamped with the wall-clock time of its first sample, so the app can line audio up with video exactly.
//
// Chunk format (little-endian):
//   u32 magic 'RCA1' | u8 track | u8 channels | u16 0 | u32 sample rate | u32 frames | f64 epoch ms
//   followed by frames * channels * 2 bytes of signed 16-bit PCM.
//
// Build (Visual Studio developer prompt):
//   cl /nologo /O2 /EHsc /std:c++17 /utf-8 rc-audio.cpp /Fe:rc-audio.exe ole32.lib

#ifndef UNICODE
#define UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _MSC_VER
#pragma comment(lib, "ole32.lib")
#endif

// ---------- process loopback declarations (from audioclientactivationparams.h, Windows SDK 20348+) ----------
// Declared here so the helper builds with older SDKs and MinGW too.
namespace rc {
enum ActivationType { ACTIVATION_TYPE_DEFAULT = 0, ACTIVATION_TYPE_PROCESS_LOOPBACK = 1 };
enum LoopbackMode { LOOPBACK_INCLUDE_TARGET_PROCESS_TREE = 0, LOOPBACK_EXCLUDE_TARGET_PROCESS_TREE = 1 };
struct ProcessLoopbackParams {
  DWORD TargetProcessId;
  LoopbackMode ProcessLoopbackMode;
};
struct ActivationParams {
  ActivationType Type;
  ProcessLoopbackParams Loopback;
};
const wchar_t *const kProcessLoopbackDevice = L"VAD\\Process_Loopback";
typedef HRESULT(WINAPI *ActivateAsyncFn)(LPCWSTR, REFIID, PROPVARIANT *, IActivateAudioInterfaceCompletionHandler *,
                                          IActivateAudioInterfaceAsyncOperation **);
}  // namespace rc

static const UINT32 kRate = 48000;
static const UINT16 kChannels = 2;
static const UINT32 kBytesPerFrame = kChannels * 2;
static const REFERENCE_TIME kBufferHns = 1000000;  // 100 ms WASAPI buffer
static const int kLatencyMs = 150;                 // how far behind real time the writer stays
static const int kResyncMs = 20;                   // timestamp error that triggers a resync

static std::atomic<bool> g_stop{false};
static std::mutex g_errMutex;
static LARGE_INTEGER g_qpcFreq;
static int64_t g_startHns = 0;      // QPC at start, in 100 ns units
static double g_startEpochMs = 0;   // wall clock at the same moment

// ---------- small helpers ----------

static std::string utf8(const wchar_t *w) {
  if (!w) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return std::string();
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

static std::string jsonEscape(const std::string &s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof buf, "\\u%04x", c);
          o += buf;
        } else {
          o += static_cast<char>(c);
        }
    }
  }
  return o;
}

static void status(const std::string &json) {
  std::lock_guard<std::mutex> lock(g_errMutex);
  std::string line = json + "\n";
  DWORD written = 0;
  WriteFile(GetStdHandle(STD_ERROR_HANDLE), line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
}

static void statusError(int track, const char *what, HRESULT hr) {
  char buf[64];
  snprintf(buf, sizeof buf, "0x%08lx", static_cast<unsigned long>(hr));
  status(std::string("{\"event\":\"error\",\"track\":") + std::to_string(track) + ",\"message\":\"" + jsonEscape(what) +
         "\",\"hr\":\"" + buf + "\"}");
}

static int64_t nowHns() {
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  // Split to avoid overflow: whole seconds plus remainder.
  return (c.QuadPart / g_qpcFreq.QuadPart) * 10000000LL + (c.QuadPart % g_qpcFreq.QuadPart) * 10000000LL / g_qpcFreq.QuadPart;
}

static double nowEpochMs() {
  FILETIME ft;
  GetSystemTimePreciseAsFileTime(&ft);
  ULARGE_INTEGER u;
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  // FILETIME counts 100 ns since 1601-01-01.
  return (static_cast<double>(u.QuadPart) - 116444736000000000.0) / 10000.0;
}

static WAVEFORMATEX captureFormat() {
  WAVEFORMATEX f = {};
  f.wFormatTag = WAVE_FORMAT_PCM;
  f.nChannels = kChannels;
  f.nSamplesPerSec = kRate;
  f.wBitsPerSample = 16;
  f.nBlockAlign = static_cast<WORD>(kBytesPerFrame);
  f.nAvgBytesPerSec = kRate * kBytesPerFrame;
  f.cbSize = 0;
  return f;
}

template <class T>
static void safeRelease(T *&p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

// ---------- per-app activation ----------

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
 public:
  ActivationHandler() : ref_(1), done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~ActivationHandler() {
    if (done_) CloseHandle(done_);
    safeRelease(client);
  }
  STDMETHODIMP QueryInterface(REFIID riid, void **ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
    } else if (riid == __uuidof(IAgileObject)) {
      *ppv = static_cast<IAgileObject *>(this);
    } else {
      *ppv = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return static_cast<ULONG>(InterlockedIncrement(&ref_)); }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG r = static_cast<ULONG>(InterlockedDecrement(&ref_));
    if (r == 0) delete this;
    return r;
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation *op) override {
    HRESULT activateHr = E_FAIL;
    IUnknown *unk = nullptr;
    HRESULT hr = op->GetActivateResult(&activateHr, &unk);
    if (SUCCEEDED(hr) && SUCCEEDED(activateHr) && unk) {
      result = unk->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void **>(&client));
    } else {
      result = FAILED(hr) ? hr : activateHr;
    }
    safeRelease(unk);
    SetEvent(done_);
    return S_OK;
  }
  bool wait(DWORD ms) { return WaitForSingleObject(done_, ms) == WAIT_OBJECT_0; }

  HRESULT result = E_FAIL;
  IAudioClient *client = nullptr;

 private:
  LONG ref_;
  HANDLE done_;
};

static HRESULT activateProcessLoopback(DWORD pid, IAudioClient **out) {
  *out = nullptr;
  HMODULE mod = LoadLibraryW(L"Mmdevapi.dll");
  if (!mod) return HRESULT_FROM_WIN32(GetLastError());
  auto activate = reinterpret_cast<rc::ActivateAsyncFn>(GetProcAddress(mod, "ActivateAudioInterfaceAsync"));
  if (!activate) return HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);

  rc::ActivationParams params = {};
  params.Type = rc::ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.Loopback.TargetProcessId = pid;
  params.Loopback.ProcessLoopbackMode = rc::LOOPBACK_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT pv;
  PropVariantInit(&pv);
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE *>(&params);

  ActivationHandler *handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation *op = nullptr;
  HRESULT hr = activate(rc::kProcessLoopbackDevice, __uuidof(IAudioClient), &pv, handler, &op);
  if (SUCCEEDED(hr)) {
    if (!handler->wait(5000)) hr = HRESULT_FROM_WIN32(WAIT_TIMEOUT);
    else hr = handler->result;
    if (SUCCEEDED(hr)) {
      *out = handler->client;
      handler->client = nullptr;
    }
  }
  safeRelease(op);
  handler->Release();
  return hr;
}

// ---------- device helpers ----------

static IMMDeviceEnumerator *enumerator() {
  IMMDeviceEnumerator *e = nullptr;
  CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void **>(&e));
  return e;
}

static std::string deviceName(IMMDevice *dev) {
  IPropertyStore *props = nullptr;
  std::string name;
  if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props))) {
    PROPVARIANT v;
    PropVariantInit(&v);
    if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = utf8(v.pwszVal);
    PropVariantClear(&v);
    props->Release();
  }
  return name;
}

static std::string deviceId(IMMDevice *dev) {
  LPWSTR id = nullptr;
  std::string s;
  if (SUCCEEDED(dev->GetId(&id)) && id) {
    s = utf8(id);
    CoTaskMemFree(id);
  }
  return s;
}

static std::string listDevices(IMMDeviceEnumerator *e, EDataFlow flow) {
  std::string out = "[";
  std::string defId;
  IMMDevice *def = nullptr;
  if (SUCCEEDED(e->GetDefaultAudioEndpoint(flow, eConsole, &def))) {
    defId = deviceId(def);
    def->Release();
  }
  IMMDeviceCollection *coll = nullptr;
  if (SUCCEEDED(e->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &coll))) {
    UINT count = 0;
    coll->GetCount(&count);
    for (UINT i = 0; i < count; i++) {
      IMMDevice *dev = nullptr;
      if (FAILED(coll->Item(i, &dev))) continue;
      std::string id = deviceId(dev);
      if (out.size() > 1) out += ",";
      out += "{\"id\":\"" + jsonEscape(id) + "\",\"name\":\"" + jsonEscape(deviceName(dev)) + "\",\"isDefault\":" +
             (id == defId ? "true" : "false") + "}";
      dev->Release();
    }
    coll->Release();
  }
  return out + "]";
}

static bool processLoopbackSupported() {
  // Per-app capture needs Windows 10 build 20348 or later. RtlGetVersion isn't affected by manifests.
  typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return false;
  auto fn = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (!fn) return false;
  RTL_OSVERSIONINFOW v = {};
  v.dwOSVersionInfoSize = sizeof(v);
  if (fn(&v) != 0) return false;
  return v.dwMajorVersion > 10 || (v.dwMajorVersion == 10 && v.dwBuildNumber >= 20348);
}

// ---------- tracks ----------

struct Packet {
  int64_t pos;  // in frames, relative to g_startHns
  std::vector<int16_t> samples;  // empty = silence of `frames` length
  uint32_t frames;
};

struct Track {
  int index = 0;
  std::mutex mutex;
  std::deque<Packet> queue;
  int64_t written = 0;       // frames already sent to stdout
  int64_t nextContig = -1;   // where the next packet goes if it is contiguous
  std::atomic<bool> enabled{false};
};

static Track g_tracks[2];

static void queuePacket(Track &t, const BYTE *data, UINT32 frames, DWORD flags, UINT64 qpcHns) {
  int64_t at = (qpcHns != 0) ? static_cast<int64_t>(qpcHns) : nowHns() - static_cast<int64_t>(frames) * 10000000LL / kRate;
  int64_t pos = (at - g_startHns) * static_cast<int64_t>(kRate) / 10000000LL;
  // Packets that follow each other are placed back to back (no clicks); a jump bigger than kResyncMs
  // (a pause in the audio, a device change) re-anchors the track on the packet's own timestamp.
  if (t.nextContig >= 0 && std::llabs(pos - t.nextContig) <= static_cast<int64_t>(kRate) * kResyncMs / 1000) pos = t.nextContig;
  t.nextContig = pos + frames;
  Packet p;
  p.pos = pos;
  p.frames = frames;
  if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data) {
    const int16_t *s = reinterpret_cast<const int16_t *>(data);
    p.samples.assign(s, s + static_cast<size_t>(frames) * kChannels);
  }
  std::lock_guard<std::mutex> lock(t.mutex);
  t.queue.push_back(std::move(p));
  // Never hold more than ~10 s if the writer stalls.
  while (t.queue.size() > 2000) t.queue.pop_front();
}

enum class Source { ProcessLoopback, EndpointLoopback, Mic };

struct CaptureArgs {
  Source source;
  DWORD pid = 0;
  std::wstring micId;  // empty = default
  int track = 0;
};

static HRESULT openClient(const CaptureArgs &a, IAudioClient **client, std::string &label) {
  *client = nullptr;
  WAVEFORMATEX fmt = captureFormat();
  HRESULT hr = S_OK;
  DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  if (a.source == Source::ProcessLoopback) {
    hr = activateProcessLoopback(a.pid, client);
    if (FAILED(hr)) return hr;
    label = "game app";
    flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
  } else {
    IMMDeviceEnumerator *e = enumerator();
    if (!e) return E_FAIL;
    IMMDevice *dev = nullptr;
    if (a.source == Source::EndpointLoopback) {
      hr = e->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
      flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
    } else if (!a.micId.empty()) {
      hr = e->GetDevice(a.micId.c_str(), &dev);
      if (FAILED(hr)) hr = e->GetDefaultAudioEndpoint(eCapture, eConsole, &dev);
    } else {
      hr = e->GetDefaultAudioEndpoint(eCapture, eConsole, &dev);
    }
    e->Release();
    if (FAILED(hr)) return hr;
    label = deviceName(dev);
    hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void **>(client));
    dev->Release();
    if (FAILED(hr)) return hr;
  }
  hr = (*client)->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, kBufferHns, 0, &fmt, nullptr);
  if (FAILED(hr)) safeRelease(*client);
  return hr;
}

static void captureThread(CaptureArgs a) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  Track &t = g_tracks[a.track];
  const char *mode = a.source == Source::ProcessLoopback ? "process" : a.source == Source::EndpointLoopback ? "loopback" : "mic";
  HANDLE evt = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  int failures = 0;
  while (!g_stop) {
    IAudioClient *client = nullptr;
    IAudioCaptureClient *cap = nullptr;
    std::string label;
    HRESULT hr = openClient(a, &client, label);
    if (SUCCEEDED(hr)) hr = client->SetEventHandle(evt);
    if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void **>(&cap));
    if (SUCCEEDED(hr)) hr = client->Start();
    if (FAILED(hr)) {
      statusError(a.track, a.source == Source::ProcessLoopback ? "could not capture the game's audio" : "could not open audio device", hr);
      safeRelease(cap);
      safeRelease(client);
      // The per-app capture is the only one that can't recover by itself; let the app decide.
      if (a.source == Source::ProcessLoopback && ++failures >= 3) {
        status(std::string("{\"event\":\"track-failed\",\"track\":") + std::to_string(a.track) + ",\"mode\":\"" + mode + "\"}");
        break;
      }
      for (int i = 0; i < 20 && !g_stop; i++) Sleep(100);
      continue;
    }
    failures = 0;
    t.enabled = true;
    status(std::string("{\"event\":\"started\",\"track\":") + std::to_string(a.track) + ",\"mode\":\"" + mode +
           "\",\"device\":\"" + jsonEscape(label) + "\",\"rate\":" + std::to_string(kRate) + ",\"channels\":" +
           std::to_string(kChannels) + "}");
    while (!g_stop) {
      WaitForSingleObject(evt, 10);
      UINT32 next = 0;
      hr = cap->GetNextPacketSize(&next);
      while (SUCCEEDED(hr) && next > 0) {
        BYTE *data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        UINT64 devPos = 0, qpcPos = 0;
        hr = cap->GetBuffer(&data, &frames, &flags, &devPos, &qpcPos);
        if (FAILED(hr)) break;
        if (frames) queuePacket(t, data, frames, flags, qpcPos);
        cap->ReleaseBuffer(frames);
        hr = cap->GetNextPacketSize(&next);
      }
      if (FAILED(hr)) break;  // device unplugged or format changed: reopen
    }
    if (FAILED(hr) && !g_stop) statusError(a.track, "audio device changed, reopening", hr);
    client->Stop();
    safeRelease(cap);
    safeRelease(client);
    t.nextContig = -1;
    if (!g_stop) Sleep(300);
  }
  CloseHandle(evt);
  CoUninitialize();
}

// ---------- writer ----------

static bool writeAll(const void *data, size_t len) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  const char *p = static_cast<const char *>(data);
  while (len > 0) {
    DWORD n = 0;
    if (!WriteFile(out, p, static_cast<DWORD>(std::min<size_t>(len, 1 << 20)), &n, nullptr) || n == 0) return false;
    p += n;
    len -= n;
  }
  return true;
}

static bool emit(int track, int64_t startFrame, const std::vector<int16_t> &pcm) {
  if (pcm.empty()) return true;
  uint8_t h[24] = {};
  const uint32_t magic = 0x31414352;  // 'RCA1'
  const uint32_t frames = static_cast<uint32_t>(pcm.size() / kChannels);
  const double epoch = g_startEpochMs + static_cast<double>(startFrame) * 1000.0 / kRate;
  memcpy(h + 0, &magic, 4);
  h[4] = static_cast<uint8_t>(track);
  h[5] = static_cast<uint8_t>(kChannels);
  memcpy(h + 8, &kRate, 4);
  memcpy(h + 12, &frames, 4);
  memcpy(h + 16, &epoch, 8);
  return writeAll(h, sizeof h) && writeAll(pcm.data(), pcm.size() * sizeof(int16_t));
}

static void writerLoop() {
  std::vector<int16_t> out;
  const int64_t maxGap = static_cast<int64_t>(kRate) * 10;
  while (!g_stop) {
    Sleep(20);
    const int64_t due = (nowHns() - g_startHns) * static_cast<int64_t>(kRate) / 10000000LL - static_cast<int64_t>(kRate) * kLatencyMs / 1000;
    for (Track &t : g_tracks) {
      if (!t.enabled) continue;
      std::deque<Packet> items;
      {
        std::lock_guard<std::mutex> lock(t.mutex);
        items.swap(t.queue);
      }
      out.clear();
      int64_t start = t.written;
      auto flush = [&]() {
        if (!emit(t.index, start, out)) g_stop = true;  // stdout closed: the app is gone
        out.clear();
        start = t.written;
      };
      for (Packet &p : items) {
        if (p.pos - t.written > maxGap) {
          // A clock jump: don't write minutes of silence, start a new chunk at the packet instead.
          flush();
          t.written = p.pos;
          start = t.written;
        } else if (p.pos > t.written) {
          out.insert(out.end(), static_cast<size_t>(p.pos - t.written) * kChannels, 0);  // gap: silence
          t.written = p.pos;
        }
        int64_t skip = t.written - p.pos;  // overlap with what is already written
        if (skip >= static_cast<int64_t>(p.frames)) continue;
        if (skip < 0) skip = 0;
        uint32_t n = p.frames - static_cast<uint32_t>(skip);
        if (p.samples.empty()) out.insert(out.end(), static_cast<size_t>(n) * kChannels, 0);
        else out.insert(out.end(), p.samples.begin() + static_cast<size_t>(skip) * kChannels, p.samples.end());
        t.written += n;
      }
      if (t.written < due) {
        // Nothing is playing (loopback delivers no packets in silence): keep the track moving.
        int64_t fill = std::min<int64_t>(due - t.written, maxGap);
        if (due - t.written > maxGap) {
          flush();
          t.written = due - fill;
          start = t.written;
        }
        out.insert(out.end(), static_cast<size_t>(fill) * kChannels, 0);
        t.written += fill;
      }
      flush();
    }
  }
}

static void stdinWatcher() {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  char buf[64];
  DWORD n = 0;
  while (!g_stop) {
    if (!ReadFile(in, buf, sizeof buf, &n, nullptr) || n == 0) break;
    for (DWORD i = 0; i < n; i++)
      if (buf[i] == 'q') g_stop = true;
  }
  g_stop = true;
}

// ---------- main ----------

static int cmdList() {
  IMMDeviceEnumerator *e = enumerator();
  if (!e) {
    printf("{\"error\":\"no audio devices\"}\n");
    return 1;
  }
  std::string json = std::string("{\"capture\":") + listDevices(e, eCapture) + ",\"render\":" + listDevices(e, eRender) +
                     ",\"processLoopback\":" + (processLoopbackSupported() ? "true" : "false") + "}\n";
  e->Release();
  fwrite(json.data(), 1, json.size(), stdout);
  fflush(stdout);
  return 0;
}

static int cmdCapture(int argc, wchar_t **argv) {
  DWORD pid = 0;
  bool loopback = false, game = true, mic = false;
  std::wstring micId;
  for (int i = 2; i < argc; i++) {
    std::wstring a = argv[i];
    if (a == L"--game-pid" && i + 1 < argc) pid = static_cast<DWORD>(_wtoi(argv[++i]));
    else if (a == L"--game-loopback") loopback = true;
    else if (a == L"--no-game") game = false;
    else if (a == L"--mic" && i + 1 < argc) {
      mic = true;
      micId = argv[++i];
      if (micId == L"default") micId.clear();
    }
  }
  QueryPerformanceFrequency(&g_qpcFreq);
  g_startHns = nowHns();
  g_startEpochMs = nowEpochMs();
  g_tracks[0].index = 0;
  g_tracks[1].index = 1;

  std::vector<std::thread> threads;
  if (game) {
    CaptureArgs a;
    a.track = 0;
    a.pid = pid;
    a.source = (pid && !loopback && processLoopbackSupported()) ? Source::ProcessLoopback : Source::EndpointLoopback;
    if (a.source == Source::EndpointLoopback && pid && !loopback)
      status("{\"event\":\"notice\",\"message\":\"per-app audio needs Windows 11; recording all desktop sound instead\"}");
    threads.emplace_back(captureThread, a);
  }
  if (mic) {
    CaptureArgs a;
    a.track = 1;
    a.source = Source::Mic;
    a.micId = micId;
    threads.emplace_back(captureThread, a);
  }
  std::thread watcher(stdinWatcher);
  watcher.detach();  // ReadFile on a pipe can't be cancelled portably; the process exit ends it
  std::thread writer(writerLoop);
  for (auto &t : threads) t.join();
  // Capture threads only end on stop, or when per-app capture keeps failing: switch to desktop sound.
  if (!g_stop && game && pid && !loopback) {
    CaptureArgs a;
    a.track = 0;
    a.source = Source::EndpointLoopback;
    status("{\"event\":\"notice\",\"message\":\"falling back to all desktop sound for the game track\"}");
    std::thread fb(captureThread, a);
    fb.join();
  }
  g_stop = true;
  writer.join();
  status("{\"event\":\"stopped\"}");
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  SetConsoleOutputCP(CP_UTF8);
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return 2;
  int rc = 1;
  std::wstring cmd = argc > 1 ? argv[1] : L"";
  if (cmd == L"list") rc = cmdList();
  else if (cmd == L"capture") rc = cmdCapture(argc, argv);
  else fprintf(stderr, "usage: rc-audio list | capture [--game-pid N] [--game-loopback] [--no-game] [--mic ID|default]\n");
  CoUninitialize();
  return rc;
}
