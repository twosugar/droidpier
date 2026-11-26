// iOS 模拟器的画面和触摸：网关为每台连上的模拟器起一个这个进程（gateway/src/ios-sim.ts），不开 Simulator.app。
// 画面：CoreSimulator 的帧缓冲每画一帧回调一次，交给 VideoToolbox 硬件编码成 H.264（Annex B）；画面不动时不编码。
// 输入：优先发给模拟器里的 dtuhidd（XPC，见 dtuConnect）；连不上才用 SimulatorKit 的 Indigo 消息。都是 Xcode 里的私有接口，
// 只在 Xcode 27.1 上验证过（2026-11-21 实测），Xcode 升级后可能要跟着改。
//
// 用法：simhelper <Xcode Developer 目录> <模拟器 UDID>
// stdout：一帧一个包，[u32 小端 长度][u8 类型][内容]，长度不含自己的 4 字节。
//   类型 1 视频：[u8 标志：第 0 位配置包、第 1 位关键帧][u32 宽][u32 高][Annex B 数据]
//   类型 2 事件：UTF-8 JSON，{"t":"ready","width":..,"height":..,"rotation":..,"rotate":bool,"hinge":bool} 或 {"t":"error","message":..}
//   （rotate：能转设备朝向；hinge：是折叠机、能开合铰链）
// stdin：一行一个 JSON 命令。{"t":"touch","x":..,"y":..,"down":true|false,"edge":0..4}（帧缓冲像素；edge 是从哪条屏幕边缘
//   开始的系统手势，3 是底边：全面屏的回主屏、多任务要带上它，系统才认，2026-11-22 iOS 18.3 实测）、{"t":"keyframe"}、
//   {"t":"button","source":..,"down":..}（硬件按键，source 见 gateway/src/ios-keys.ts）、{"t":"hidkey","usage":..,"down":..}（键盘，USB HID 键码）、
//   {"t":"hinge","angle":0..180}（折叠机的铰链角度，0 合上、180 展开）、{"t":"orient","value":"portrait"|"landscape-right"|"pud"|"landscape-left"}（设备朝向）
// stdin 关闭即退出。
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOSurface/IOSurface.h>
#import <VideoToolbox/VideoToolbox.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <dlfcn.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <xpc/xpc.h>
#import <IOKit/IOCFSerialize.h>

#define CALL(o, s) ((id(*)(id, SEL))objc_msgSend)(o, sel_registerName(s))

// 参数按 Xcode 27.1 反汇编确认：两个触点、HID 目标、NSEventType、边缘、屏幕尺寸（触点用 0..1 的比例时传 1,1）
typedef void *(*MouseFn)(CGPoint *, CGPoint *, uint32_t, uint64_t, uint64_t, double, double);
// 按 Xcode 27.1 反汇编确认：按键来源、方向（1 按下、2 抬起）、目标；键盘是 HID 键码、方向
typedef void *(*ButtonFn)(uint32_t, uint32_t, uint32_t);
typedef void *(*KeyboardFn)(uint32_t, uint32_t);
// 硬件按键的 HID 目标（idb 的 FBSimulatorIndigoHID 用的同一个值）
static const uint32_t TARGET_HARDWARE = 0x33;
// 触摸屏的 HID 目标（idb 的 FBSimulatorIndigoHID 用的同一个值）
static const uint32_t TARGET_DIGITIZER = 0x32;
enum { EV_DOWN = 1, EV_UP = 2, EV_DRAG = 6 };

static dispatch_queue_t outQ;
// 都放全局：ARC 会在局部变量最后一次使用后就释放，进 dispatch_main 前 device 就没了，SimulatorKit 的 HID 监视队列随后访问它崩掉
static id device, screenPort, hidClient;
static MouseFn mouseMessage;
static ButtonFn buttonMessage;
static KeyboardFn keyboardMessage;
static size_t fbWidth, fbHeight;
// 界面方向（设备顺时针转过的角度）和转正后的视频尺寸：帧缓冲永远是竖的，界面横过来时（折叠机展开）画面在里面是躺着的，
// 编码前按方向转正，视频是 outW x outH；触摸照旧按帧缓冲坐标
static int rotationDeg, sentRotation = -1;
// 正在用的屏在 class 0 屏里的序号。encodeQ 写、inputQ 读
static _Atomic uint64_t screenIndex;
// class 0 屏的名字（外屏 LCD、内屏 LCD-1），和 screenIndex 对应；main 里定好后不再改
static NSArray<NSString *> *screenNames;
// 屏名 → dtuhidd 触摸的 target（见 loadTouchTargets）。查不到时用 screenIndex：iPhone 只有一块屏，0 是主屏的别名。只在 inputQ 上用
static NSDictionary<NSString *, NSNumber *> *touchTargets;
// 模拟器报的运动能力（CoreDevice 的 querymotioncapabilities，同 idb 的 MotionCapabilities）：deviceMotion 时设备朝向走厂商事件，
// 否则走 Purple；hingeAngle 只有 iPhone Duo 有（2026-11-26 实测 iOS 27.1 Duo 两个都是 true，iOS 18.3 iPhone 16 Pro 都是 false）。
// main 里查一次
static BOOL deviceMotion, hingeAngle, canRotate;
// 按下时发给的屏：手指抬起前不换，开合铰链时旧屏上不会留下一根抬不起来的手指。只在 inputQ 上用
static uint64_t touchTarget;
static size_t outW, outH;
static VTPixelRotationSessionRef rotator;
static CVPixelBufferPoolRef rotatedPool;
static VTCompressionSessionRef encoder;
static BOOL forceKey = YES, touching = NO;
static NSData *lastConfig;

static void writeAll(const void *p, size_t n) {
  const uint8_t *b = p;
  while (n) {
    ssize_t w = write(STDOUT_FILENO, b, n);
    if (w < 0 && errno == EINTR) continue;
    // 网关关掉管道（EPIPE）就退出
    if (w <= 0) exit(0);
    b += w; n -= (size_t)w;
  }
}

static void emit(uint8_t type, NSData *body) {
  dispatch_async(outQ, ^{
    uint32_t len = (uint32_t)body.length + 1;
    writeAll(&len, 4);
    writeAll(&type, 1);
    writeAll(body.bytes, body.length);
  });
}

static void event(NSDictionary *d) { emit(2, [NSJSONSerialization dataWithJSONObject:d options:0 error:nil]); }

static void fail(NSString *msg) {
  event(@{@"t": @"error", @"message": msg});
  dispatch_sync(outQ, ^{});
  exit(1);
}

static void video(BOOL config, BOOL key, NSData *data) {
  NSMutableData *b = [NSMutableData dataWithCapacity:data.length + 9];
  uint8_t flags = (config ? 1 : 0) | (key ? 2 : 0);
  uint32_t w = (uint32_t)outW, h = (uint32_t)outH;
  [b appendBytes:&flags length:1];
  [b appendBytes:&w length:4];
  [b appendBytes:&h length:4];
  [b appendData:data];
  emit(1, b);
}

static const uint8_t START[4] = {0, 0, 0, 1};

// SPS/PPS 从格式描述里取，拼成 Annex B；格式没变就不重发
static void sendConfig(CMFormatDescriptionRef fmt) {
  size_t count = 0;
  CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, 0, NULL, NULL, &count, NULL);
  NSMutableData *cfg = [NSMutableData data];
  for (size_t i = 0; i < count; i++) {
    const uint8_t *p; size_t n;
    if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, i, &p, &n, NULL, NULL) != noErr) return;
    [cfg appendBytes:START length:4];
    [cfg appendBytes:p length:n];
  }
  if ([cfg isEqualToData:lastConfig]) return;
  lastConfig = cfg;
  video(YES, NO, cfg);
}

static void onEncoded(OSStatus st, CMSampleBufferRef sb) {
  if (st != noErr || !sb || !CMSampleBufferDataIsReady(sb)) return;
  CFArrayRef att = CMSampleBufferGetSampleAttachmentsArray(sb, false);
  BOOL key = !(att && CFArrayGetCount(att) && CFDictionaryContainsKey(CFArrayGetValueAtIndex(att, 0), kCMSampleAttachmentKey_NotSync));
  if (key) sendConfig(CMSampleBufferGetFormatDescription(sb));
  // VideoToolbox 出的是 4 字节长度前缀（AVCC），页面的 WebCodecs 按 Annex B 解码：把长度换成起始码
  CMBlockBufferRef bb = CMSampleBufferGetDataBuffer(sb);
  size_t total = CMBlockBufferGetDataLength(bb);
  NSMutableData *out = [NSMutableData dataWithLength:total];
  if (CMBlockBufferCopyDataBytes(bb, 0, total, out.mutableBytes) != noErr) return;
  uint8_t *p = out.mutableBytes;
  for (size_t off = 0; off + 4 <= total;) {
    uint32_t n = CFSwapInt32BigToHost(*(uint32_t *)(p + off));
    memcpy(p + off, START, 4);
    off += 4 + n;
  }
  video(NO, key, out);
}

static void createEncoder(void) {
  NSDictionary *spec = @{(id)kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: @YES};
  OSStatus st = VTCompressionSessionCreate(NULL, (int32_t)outW, (int32_t)outH, kCMVideoCodecType_H264,
                                           (__bridge CFDictionaryRef)spec, NULL, NULL, NULL, NULL, &encoder);
  if (st != noErr) fail([NSString stringWithFormat:@"创建 H.264 编码器失败（%d）", (int)st]);
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel);
  // 码率：验证时 1398x2034 持续滑动平均 4.8 Mbit/s，上限给到 12
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFTypeRef)@(12000000));
  // 画面不动时没有帧，不会自己出关键帧；新页面要看画面时由网关发 keyframe 命令
  VTSessionSetProperty(encoder, kVTCompressionPropertyKey_MaxKeyFrameInterval, (__bridge CFTypeRef)@(INT32_MAX));
}

// 帧回调和 keyframe 命令都在 encodeQ 上跑，encoder / forceKey 只在这里改；fbWidth / fbHeight 也在这里写，inputQ 只读
static dispatch_queue_t encodeQ;
static int64_t pts;

static void encodeCurrent(void);
// 画面停下 100 ms 后把同一帧再编一遍、编成关键帧：浏览器的硬件解码器总压着最近的帧，收到下一帧才吐出来，
// 画面静止时最后一帧、切过来时的关键帧就一直显示不出来。重复成 P 帧不行：2026-11-21 Chrome 实测关键帧后跟几个
// P 帧都一帧不出，再来一个关键帧（IDR 会让解码器把压着的帧全吐出来）才出。代价是每次停下多一个关键帧（约 30 KB）。
// scrcpy 那边靠 Android 编码器「100 ms 没新帧就重复上一帧」，是同一个问题
static const int64_t REPEAT_AFTER_NS = 100 * NSEC_PER_MSEC;
static uint64_t frameGen;

// 帧缓冲是不是全黑：隔 16 个像素取一个点看 RGB。灭着的屏是纯黑；点亮的屏至少有状态栏的白字
static BOOL surfaceBlank(IOSurfaceRef s) {
  if (!s || IOSurfaceLock(s, kIOSurfaceLockReadOnly, NULL) != kIOReturnSuccess) return YES;
  const uint8_t *p = IOSurfaceGetBaseAddress(s);
  size_t w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s), row = IOSurfaceGetBytesPerRow(s);
  BOOL blank = YES;
  for (size_t y = 0; blank && y < h; y += 16)
    for (size_t x = 0; x < w; x += 16) {
      const uint8_t *px = p + y * row + x * 4;
      if (px[0] | px[1] | px[2]) { blank = NO; break; }
    }
  IOSurfaceUnlock(s, kIOSurfaceLockReadOnly, NULL);
  return blank;
}

static void encodeFresh(void) {
  encodeCurrent();
  uint64_t gen = ++frameGen;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, REPEAT_AFTER_NS), encodeQ, ^{
    if (gen != frameGen) return;
    forceKey = YES;
    encodeCurrent();
  });
}

// 读正在用的屏的界面方向（1 竖、2 倒、3 / 4 横），换成页面的方向（设备顺时针转过的角度）。3 对 90 是对着画面试出来的：
// 折叠机展开后是 3，按 90 转正后画面是正的、点按的位置对得上；合上是 1；iPhone 一直是 1
// （2026-11-26 Xcode 27.1 iPhone Duo / iPhone 16 Pro 实测）。只在 encodeQ 上调
static void readRotation(void) {
  id props = [screenPort respondsToSelector:sel_registerName("screenProperties")] ? CALL(screenPort, "screenProperties") : nil;
  long o = props ? ((long (*)(id, SEL))objc_msgSend)(props, sel_registerName("uiOrientation")) : 1;
  rotationDeg = o == 2 ? 180 : o == 3 ? 90 : o == 4 ? 270 : 0;
}

static void encodeCurrent(void) {
  IOSurfaceRef s = (__bridge IOSurfaceRef)CALL(screenPort, "framebufferSurface");
  if (!s) return;
  size_t w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s);
  size_t ow = rotationDeg % 180 ? h : w, oh = rotationDeg % 180 ? w : h;
  // 90 和 270（0 和 180）转正后尺寸一样，方向变了也要重发 ready，网关才知道触摸按哪个方向换算
  if (w != fbWidth || h != fbHeight || ow != outW || oh != outH || rotationDeg != sentRotation) {
    sentRotation = rotationDeg;
    fbWidth = w;
    fbHeight = h;
    outW = ow;
    outH = oh;
    if (encoder) { VTCompressionSessionInvalidate(encoder); CFRelease(encoder); encoder = NULL; }
    if (rotatedPool) { CVPixelBufferPoolRelease(rotatedPool); rotatedPool = NULL; }
    lastConfig = nil;
    forceKey = YES;
    event(@{@"t": @"ready", @"width": @(fbWidth), @"height": @(fbHeight), @"rotation": @(rotationDeg),
            @"rotate": @(canRotate), @"hinge": @(hingeAngle)});
  }
  if (!encoder) createEncoder();
  CVPixelBufferRef pb = NULL;
  if (CVPixelBufferCreateWithIOSurface(NULL, s, NULL, &pb) != kCVReturnSuccess) return;
  if (rotationDeg) {
    // 设备顺时针转了 r，画面在帧缓冲里就是逆时针躺着的：顺时针转 r 转正
    if (!rotator && VTPixelRotationSessionCreate(NULL, &rotator) != noErr) { CVPixelBufferRelease(pb); return; }
    CFStringRef angle = rotationDeg == 90 ? kVTRotation_CW90 : rotationDeg == 180 ? kVTRotation_180 : kVTRotation_CCW90;
    VTSessionSetProperty(rotator, kVTPixelRotationPropertyKey_Rotation, angle);
    if (!rotatedPool) {
      NSDictionary *attrs = @{(id)kCVPixelBufferPixelFormatTypeKey: @(CVPixelBufferGetPixelFormatType(pb)),
                              (id)kCVPixelBufferWidthKey: @(outW), (id)kCVPixelBufferHeightKey: @(outH),
                              (id)kCVPixelBufferIOSurfacePropertiesKey: @{}};
      CVPixelBufferPoolCreate(NULL, NULL, (__bridge CFDictionaryRef)attrs, &rotatedPool);
    }
    CVPixelBufferRef out = NULL;
    if (!rotatedPool || CVPixelBufferPoolCreatePixelBuffer(NULL, rotatedPool, &out) != kCVReturnSuccess ||
        VTPixelRotationSessionRotateImage(rotator, pb, out) != noErr) {
      if (out) CVPixelBufferRelease(out);
      CVPixelBufferRelease(pb);
      return;
    }
    CVPixelBufferRelease(pb);
    pb = out;
  }
  NSDictionary *opts = forceKey ? @{(id)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES} : nil;
  forceKey = NO;
  VTCompressionSessionEncodeFrameWithOutputHandler(encoder, pb, CMTimeMake(pts++, 60), kCMTimeInvalid,
                                                   (__bridge CFDictionaryRef)opts, NULL,
                                                   ^(OSStatus st, VTEncodeInfoFlags f, CMSampleBufferRef sb) { onEncoded(st, sb); });
  CVPixelBufferRelease(pb);
  // 编码器会压着最后一帧等下一帧才吐出来；画面停下时最后一帧就一直出不来，所以每帧都催一次（硬件编码 1398x2034 约 9 ms）
  VTCompressionSessionCompleteFrames(encoder, kCMTimeInvalid);
}

// 触摸都在 inputQ 上一条条发：上一条没发完就发下一条，SimulatorKit 会在自己的 HID 队列里崩（2026-11-21 实测 16 ms 一条必崩）
static dispatch_queue_t inputQ;

static void hidSend(void *msg) {
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  ((void (*)(id, SEL, void *, BOOL, id, id))objc_msgSend)(hidClient, sel_registerName("sendWithMessage:freeWhenDone:completionQueue:completion:"),
                                                          msg, YES, dispatch_get_global_queue(0, 0), ^(NSError *e) {
    if (e) event(@{@"t": @"error", @"message": [NSString stringWithFormat:@"触摸没发出去：%@", e.localizedDescription]});
    dispatch_semaphore_signal(done);
  });
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC));
}

// Xcode 27 的 CoreSimulator 起，模拟器里的 dtuhidd 收输入：XPC 字典，格式照 idb 的 DTUHID 传输（FBSimulatorControl/HID，MIT）。
// 旧的 Indigo 消息在 Xcode 27 上不可靠：按键、键盘被丢掉，触摸时灵时不灵（2026-11-23 iOS 18.3 实测重启后点按全部失效，
// idb 也是这个结论）。连不上 dtuhidd（没有这个服务的旧 Xcode / 旧系统）才用 Indigo
static NSString *const DTU_SERVICE = @"com.apple.coredevice.feature.remote.hid.digitizer";
// 厂商事件：转设备朝向、开合铰链（idb 的 SimulatorVendorHIDTransport）
static NSString *const VENDOR_SERVICE = @"com.apple.coredevice.feature.remote.hid.vendordefined";
typedef xpc_object_t (*EndpointFromPortFn)(mach_port_t, uint64_t, uint64_t) __attribute__((ns_returns_retained));
typedef xpc_connection_t (*ConnectionFromEndpointFn)(xpc_object_t) __attribute__((ns_returns_retained));
typedef void (*EnableSim2HostFn)(xpc_connection_t);
static xpc_connection_t dtu, vendor;
static BOOL dtuTouching;
static uint64_t dtuRetryAt;
static int dtuSilent;

static xpc_object_t dtuMessage(NSString *service, const char *type, xpc_object_t payload, bool barrier) {
  xpc_object_t m = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(m, "messageType", type);
  xpc_dictionary_set_bool(m, "isBarrier", barrier);
  xpc_dictionary_set_string(m, "featureIdentifier", service.UTF8String);
  xpc_dictionary_set_value(m, "payload", payload);
  return m;
}

static mach_port_t simLookup(NSString *service) {
  if (![device respondsToSelector:sel_registerName("lookup:error:")]) return MACH_PORT_NULL;
  NSError *e = nil;
  return ((mach_port_t (*)(id, SEL, id, NSError **))objc_msgSend)(device, sel_registerName("lookup:error:"), service, &e);
}

// 连模拟器里的一个 XPC 服务（sim2host），返回已 resume 的连接，连不上是 nil；onEvent 收这条连接的事件（断开等）
static xpc_connection_t simConnect(NSString *service, void (^onEvent)(xpc_object_t)) {
  EndpointFromPortFn endpointFromPort = (EndpointFromPortFn)dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
  ConnectionFromEndpointFn fromEndpoint = (ConnectionFromEndpointFn)dlsym(RTLD_DEFAULT, "xpc_connection_create_from_endpoint");
  EnableSim2HostFn sim2host = (EnableSim2HostFn)dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
  if (!endpointFromPort || !fromEndpoint || !sim2host) return nil;
  mach_port_t port = simLookup(service);
  if (port == MACH_PORT_NULL) return nil;
  xpc_object_t endpoint = endpointFromPort(port, 0, 0);
  xpc_connection_t c = endpoint ? fromEndpoint(endpoint) : nil;
  if (!c) return nil;
  sim2host(c);
  xpc_connection_set_event_handler(c, onEvent ?: ^(xpc_object_t ev) {});
  xpc_connection_resume(c);
  return c;
}

// 发一条要回复的消息，最多等 timeout 秒；没回复或回的不是字典时是 nil
static xpc_object_t simRequest(xpc_connection_t c, xpc_object_t m, int64_t timeout) {
  dispatch_semaphore_t answered = dispatch_semaphore_create(0);
  __block xpc_object_t reply = nil;
  xpc_connection_send_message_with_reply(c, m, dispatch_get_global_queue(0, 0), ^(xpc_object_t r) {
    if (xpc_get_type(r) == XPC_TYPE_DICTIONARY) reply = r;
    dispatch_semaphore_signal(answered);
  });
  if (dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, timeout * NSEC_PER_SEC))) return nil;
  return reply;
}

static xpc_object_t keyPayload(uint32_t usage, BOOL down) {
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(p, "usageCode", usage);
  xpc_dictionary_set_uint64(p, "state", down ? 1 : 2);
  return p;
}

// 在 inputQ 上调。连上后用一条 barrier 消息确认 dtuhidd 在应答（同 idb 的存活探测）；不应答就当没有
static void dtuConnect(void) {
  if (dtu) return;
  // 刚开机时 dtuhidd 可能还没起来：失败后过 5 秒再试，不是每个触摸都去连。
  // 有端口却连续 5 次不应答（idb 说的 dtuhidd 崩溃后被 launchd 限流）就不再试，免得每次都卡住输入队列 4 秒
  if (dtuSilent >= 5 || clock_gettime_nsec_np(CLOCK_UPTIME_RAW) < dtuRetryAt) return;
  __block xpc_connection_t c = nil;
  c = simConnect(DTU_SERVICE, ^(xpc_object_t ev) {
    if (ev == XPC_ERROR_CONNECTION_INTERRUPTED) dispatch_async(inputQ, ^{ dtuTouching = NO; });
    else if (ev == XPC_ERROR_CONNECTION_INVALID) dispatch_async(inputQ, ^{ if (dtu == c) { dtu = nil; dtuTouching = NO; } });
  });
  if (!c) { dtuRetryAt = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + 5 * NSEC_PER_SEC; return; }
  if (!simRequest(c, dtuMessage(DTU_SERVICE, "IndigoKeyboardButtonEvent", keyPayload(0, NO), true), 4)) {
    xpc_connection_cancel(c);
    dtuSilent++;
    dtuRetryAt = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + 5 * NSEC_PER_SEC;
    return;
  }
  dtu = c;
}

static void dtuSend(const char *type, xpc_object_t payload) {
  xpc_connection_send_message(dtu, dtuMessage(DTU_SERVICE, type, payload, false));
}

static NSString *xpcString(xpc_object_t d, const char *key) {
  const char *s = d ? xpc_dictionary_get_string(d, key) : NULL;
  return s ? @(s) : nil;
}

// 调一个 CoreDevice 动作（同 idb 的 CoreDeviceRequest），返回它的输出字典；连不上、出错、超时都是 nil
static xpc_object_t coreDevice(NSString *service, const char *action) {
  NSString *version = [NSBundle bundleWithPath:@"/Library/Developer/PrivateFrameworks/CoreDevice.framework"].infoDictionary[@"CFBundleVersion"];
  if (!version) return nil;
  xpc_object_t components = xpc_array_create(NULL, 0);
  for (NSString *part in [version componentsSeparatedByString:@"."]) xpc_array_set_uint64(components, XPC_ARRAY_APPEND, (uint64_t)part.longLongValue);
  xpc_object_t ver = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(ver, "components", components);
  xpc_dictionary_set_int64(ver, "originalComponentsCount", (int64_t)xpc_array_get_count(components));
  xpc_dictionary_set_string(ver, "stringValue", version.UTF8String);
  xpc_object_t req = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(req, "CoreDevice.actionIdentifier", action);
  xpc_dictionary_set_string(req, "CoreDevice.deviceIdentifier", [CALL(device, "UDID") UUIDString].UTF8String);
  xpc_dictionary_set_string(req, "CoreDevice.invocationIdentifier", NSUUID.UUID.UUIDString.UTF8String);
  xpc_dictionary_set_int64(req, "CoreDevice.CoreDeviceDDIProtocolVersion", 1);
  xpc_dictionary_set_value(req, "CoreDevice.coreDeviceVersion", ver);
  xpc_dictionary_set_value(req, "CoreDevice.input", xpc_dictionary_create(NULL, NULL, 0));
  xpc_connection_t c = simConnect(service, nil);
  xpc_object_t reply = c ? simRequest(c, req, 3) : nil;
  if (c) xpc_connection_cancel(c);
  xpc_object_t out = reply ? xpc_dictionary_get_value(reply, "CoreDevice.output") : nil;
  return out && xpc_get_type(out) == XPC_TYPE_DICTIONARY ? out : nil;
}

// 没有设备运动的系统（iOS 18 等）转朝向：给 SpringBoard 的 PurpleWorkspacePort 发 GSEvent（同 idb 的 SimulatorPurpleHID，
// 格式照 Simulator.app 的 sendPurpleEvent:）：112 字节的 mach 消息，类型 50（朝向变了）| 0x20000，偏移 0x4C 是朝向。在 inputQ 上调
static void purpleOrient(uint32_t orientation) {
  mach_port_t port = simLookup(@"PurpleWorkspacePort");
  if (port == MACH_PORT_NULL) { event(@{@"t": @"error", @"message": @"找不到模拟器的 PurpleWorkspacePort"}); return; }

  uint32_t buf[28] = {0};
  mach_msg_header_t *h = (mach_msg_header_t *)buf;
  h->msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  h->msgh_size = 108;
  h->msgh_remote_port = port;
  h->msgh_id = 0x7B;
  buf[0x18 / 4] = 50 | 0x20000;
  buf[0x48 / 4] = 4;
  buf[0x4C / 4] = orientation;
  kern_return_t kr = mach_msg(h, MACH_SEND_MSG | MACH_SEND_TIMEOUT, 108, 0, MACH_PORT_NULL, 2000, MACH_PORT_NULL);
  // lookup 每次给一份发送权，用完还回去
  mach_port_deallocate(mach_task_self(), port);
  if (kr != KERN_SUCCESS) event(@{@"t": @"error", @"message": [NSString stringWithFormat:@"转朝向没发出去（%d）", kr]});
}

// 每块屏的触摸 target（同 idb 的 SimulatorTouchscreenProtocol）：CoreDevice 的 displayinfo 给出屏名和它的 uniqueId，
// dtuhidd 的 universalhidservice 列出触摸屏服务和它对着的 displayUUID，触摸屏的服务编号是 0x100 + target。
// iPhone Duo 是外屏 LCD → 1、内屏 LCD-1 → 3；内屏发 0、1、2 都点不动（2026-11-26 Xcode 27.1 iOS 27.1 实测）。
// 查不到（旧 Xcode、旧系统）就留空，触摸照旧发 screenIndex；刚开机时服务可能还没起来，按下时隔 5 秒再查，最多 6 次。在 inputQ 上调
static void loadTouchTargets(void) {
  static int tries;
  static uint64_t retryAt;
  if (touchTargets || screenNames.count < 2 || tries >= 6 || clock_gettime_nsec_np(CLOCK_UPTIME_RAW) < retryAt) return;
  tries++;
  retryAt = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + 5 * NSEC_PER_SEC;
  xpc_object_t info = coreDevice(@"com.apple.coredevice.feature.getdisplayinfo", "com.apple.coredevice.action.displayinfo");
  xpc_object_t displays = info ? xpc_dictionary_get_value(info, "displays") : nil;
  if (!displays || xpc_get_type(displays) != XPC_TYPE_ARRAY) return;
  NSMutableDictionary<NSString *, NSString *> *nameByUUID = [NSMutableDictionary dictionary];
  xpc_array_apply(displays, ^bool(size_t i, xpc_object_t d) {
    if (xpc_get_type(d) != XPC_TYPE_DICTIONARY) return true;
    NSString *name = xpcString(d, "name"), *uid = xpcString(d, "uniqueId");
    if (name && uid) nameByUUID[uid] = name;
    return true;
  });
  xpc_object_t list = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(list, "connectedServices", xpc_dictionary_create(NULL, NULL, 0));
  xpc_object_t svcReq = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_bool(svcReq, "isBarrier", false);
  xpc_dictionary_set_value(svcReq, "payload", list);
  xpc_connection_t hid = simConnect(@"com.apple.coredevice.feature.remote.universalhidservice", nil);
  xpc_object_t svcReply = hid ? simRequest(hid, svcReq, 3) : nil;
  if (hid) xpc_connection_cancel(hid);
  xpc_object_t services = svcReply ? xpc_dictionary_get_value(svcReply, "connectedServices") : nil;
  if (!services || xpc_get_type(services) != XPC_TYPE_ARRAY) return;
  NSMutableDictionary<NSString *, NSNumber *> *targets = [NSMutableDictionary dictionary];
  xpc_array_apply(services, ^bool(size_t i, xpc_object_t s) {
    // 触摸屏：数字化仪页 0x0D、用法 0x04
    if (xpc_get_type(s) != XPC_TYPE_DICTIONARY || xpc_dictionary_get_uint64(s, "PrimaryUsagePage") != 0x0D || xpc_dictionary_get_uint64(s, "PrimaryUsage") != 0x04) return true;
    uint64_t sid = xpc_dictionary_get_uint64(s, "_ServiceID");
    NSString *name = nameByUUID[xpcString(s, "displayUUID") ?: @""];
    if ((sid & ~0xFFull) == 0x100 && (sid & 0xFF) && name) targets[name] = @(sid & 0xFF);
    return true;
  });
  touchTargets = targets;
}

// 发一条厂商事件（idb 的 IndigoVendorDefinedEvent.virtualMachineControl）：IOCFSerialize 二进制序列化的字典，
// 模拟器里的 locationd 按 source / type 认（hinge-slider-control 的值是角度，orientation-picker-control 的值是朝向名）。
// 连接一直开着、启动时就连（vendorConnect）：dtuhidd 每条连接新建一批虚拟 HID 服务，系统约 0.3 秒后才匹配上，
// 刚连上就发的事件会被丢掉（2026-11-26 iPhone Duo 实测）。在 inputQ 上调
static BOOL vendorConnect(void) {
  if (vendor || !(deviceMotion || hingeAngle)) return NO;
  __block xpc_connection_t c = nil;
  c = simConnect(VENDOR_SERVICE, ^(xpc_object_t ev) {
    // 断开或 dtuhidd 重启（INTERRUPTED）都重连：重启后旧连接上的虚拟服务没了，要走重连后等匹配的路
    if (ev == XPC_ERROR_CONNECTION_INVALID || ev == XPC_ERROR_CONNECTION_INTERRUPTED)
      dispatch_async(inputQ, ^{ if (vendor == c) { xpc_connection_cancel(c); vendor = nil; } });
  });
  vendor = c;
  return c != nil;
}

static void vendorSend(NSString *source, NSString *type, id value) {
  // 断了重连：等虚拟服务匹配上再发
  if (vendorConnect()) usleep(1000000);
  if (!vendor) { event(@{@"t": @"error", @"message": @"连不上模拟器的厂商事件服务（dtuhidd）"}); return; }
  NSDictionary *d = @{@"provider": @"com.apple.Virtualization.VirtualMachines", @"source": source, @"type": type, @"value": value};
  CFDataRef data = IOCFSerialize((__bridge CFTypeRef)d, kIOCFSerializeToBinary);
  if (!data) return;
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(p, "usagePage", 0xff61);
  xpc_dictionary_set_uint64(p, "usage", 0x5b);
  xpc_dictionary_set_uint64(p, "version", 0);
  xpc_dictionary_set_data(p, "data", CFDataGetBytePtr(data), (size_t)CFDataGetLength(data));
  CFRelease(data);
  xpc_connection_send_message(vendor, dtuMessage(VENDOR_SERVICE, "IndigoVendorDefinedEvent", p, false));
}

static void touch(double x, double y, BOOL down, uint64_t edge) {
  if (!fbWidth || !fbHeight) return;
  // 只在没有手指按着时换路：一次滑动中途换过去，旧路上的手指就永远抬不起来
  if (!touching && !dtuTouching) dtuConnect();
  if (dtu && !touching) {
    if (!down && !dtuTouching) return;
    xpc_object_t point = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_double(point, "x", fmin(fmax(x / fbWidth, 0), 1));
    xpc_dictionary_set_double(point, "y", fmin(fmax(y / fbHeight, 0), 1));
    xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_value(p, "pointOne", point);
    // 0 开始、1 移动、2 结束
    xpc_dictionary_set_uint64(p, "eventType", !down ? 2 : dtuTouching ? 1 : 0);
    xpc_dictionary_set_uint64(p, "edge", edge);
    if (down && !dtuTouching) {
      loadTouchTargets();
      uint64_t i = screenIndex;
      NSNumber *t = i < screenNames.count ? touchTargets[screenNames[i]] : nil;
      touchTarget = t ? t.unsignedLongLongValue : i;
    }
    xpc_dictionary_set_uint64(p, "target", touchTarget);
    dtuTouching = down;
    dtuSend("IndigoDigitizerEvent", p);
    return;
  }
  uint64_t type = !down ? EV_UP : touching ? EV_DRAG : EV_DOWN;
  if (!down && !touching) return;
  touching = down;
  CGPoint p = {fmin(fmax(x / fbWidth, 0), 1), fmin(fmax(y / fbHeight, 0), 1)};
  // 偶尔返回空（一次滑动里约一条，原因不明，2026-11-21 实测）；空消息发出去 SimulatorKit 直接崩。重试一次，还是空就丢掉这一个采样点
  void *msg = mouseMessage(&p, NULL, TARGET_DIGITIZER, type, edge, 1.0, 1.0);
  if (!msg) msg = mouseMessage(&p, NULL, TARGET_DIGITIZER, type, edge, 1.0, 1.0);
  if (msg) hidSend(msg);
}

static void button(uint32_t source, BOOL down) {
  dtuConnect();
  if (dtu) {
    // dtuhidd 按 Consumer 页的用法码认硬件按键（idb 的 SimulatorHIDButtonIdentity）：Home 是 Menu 0x40，锁屏是 Power 0x30
    uint64_t code = source == 0 ? 0x40 : source == 0x3e8 ? 0x30 : 0;
    if (code) {
      xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
      xpc_dictionary_set_uint64(p, "usagePage", 0x0C);
      xpc_dictionary_set_uint64(p, "usageCode", code);
      xpc_dictionary_set_uint64(p, "state", down ? 1 : 2);
      dtuSend("IndigoButtonEvent", p);
      return;
    }
  }
  void *msg = buttonMessage(source, down ? 1 : 2, TARGET_HARDWARE);
  if (msg) hidSend(msg);
}

static void hidKey(uint32_t usage, BOOL down) {
  dtuConnect();
  if (dtu) { dtuSend("IndigoKeyboardButtonEvent", keyPayload(usage, down)); return; }
  void *msg = keyboardMessage(usage, down ? 1 : 2);
  if (msg) hidSend(msg);
}

// SimulatorKit 的位置随 Xcode 版本变。Simulator.app 靠 rpath 找它，Xcode 26.0.1 的 rpath 是 Developer/Library/PrivateFrameworks、
// Contents/Frameworks、Simulator.app/Contents/Frameworks（2026-11-23 用 otool -l 看的，实际在第一个）；Xcode 27.1 在
// Contents/SharedFrameworks（2026-11-21 实测）。先试这些位置，都没有再在 Xcode 包的 Contents 下按目录名找：只找 5 层
// （26.0.1 里它在第 4 层，fd 实测 0.02 秒），给以后换位置的版本留余地。tried 记下找过哪里，找不到时报给用户
static void *loadSimulatorKit(NSString *dev, NSMutableArray<NSString *> *tried) {
  NSString *contents = [dev stringByDeletingLastPathComponent];
  NSArray<NSString *> *dirs = @[
    [contents stringByAppendingPathComponent:@"SharedFrameworks"],
    [dev stringByAppendingPathComponent:@"Library/PrivateFrameworks"],
    [contents stringByAppendingPathComponent:@"Frameworks"],
    [dev stringByAppendingPathComponent:@"Applications/Simulator.app/Contents/Frameworks"],
  ];
  for (NSString *d in dirs) {
    NSString *p = [d stringByAppendingPathComponent:@"SimulatorKit.framework/SimulatorKit"];
    [tried addObject:p];
    void *h = dlopen(p.fileSystemRepresentation, RTLD_NOW);
    if (h) return h;
  }
  NSDirectoryEnumerator<NSURL *> *it = [NSFileManager.defaultManager enumeratorAtURL:[NSURL fileURLWithPath:contents]
    includingPropertiesForKeys:nil options:NSDirectoryEnumerationSkipsHiddenFiles errorHandler:nil];
  for (NSURL *u in it) {
    if (it.level >= 5) [it skipDescendants];
    if (![u.lastPathComponent isEqualToString:@"SimulatorKit.framework"]) continue;
    [it skipDescendants];
    void *h = dlopen([u.path stringByAppendingPathComponent:@"SimulatorKit"].fileSystemRepresentation, RTLD_NOW);
    if (h) return h;
  }
  [tried addObject:[NSString stringWithFormat:@"%@ 下 5 层以内", contents]];
  return NULL;
}

static id findDevice(NSString *developerDir, NSString *udid) {
  NSError *e = nil;
  id ctx = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(objc_getClass("SimServiceContext"), sel_registerName("sharedServiceContextForDeveloperDir:error:"), developerDir, &e);
  if (!ctx) fail([NSString stringWithFormat:@"连不上 CoreSimulator：%@", e.localizedDescription]);
  id set = ((id (*)(id, SEL, NSError **))objc_msgSend)(ctx, sel_registerName("defaultDeviceSetWithError:"), &e);
  for (id d in CALL(set, "devices"))
    if ([[CALL(d, "UDID") UUIDString] isEqualToString:udid]) return d;
  return nil;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    // Node 给子进程的 stdio 是非阻塞的：管道写满时 write 返回 EAGAIN，会被当成网关走了而退出。改回阻塞
    for (int fd = 0; fd <= 1; fd++) fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK);
    signal(SIGPIPE, SIG_IGN);
    outQ = dispatch_queue_create("out", DISPATCH_QUEUE_SERIAL);
    encodeQ = dispatch_queue_create("encode", DISPATCH_QUEUE_SERIAL);
    inputQ = dispatch_queue_create("input", DISPATCH_QUEUE_SERIAL);
    if (argc < 3) fail(@"用法：simhelper <Developer 目录> <UDID>");
    NSString *dev = @(argv[1]);
    if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) fail(@"找不到 CoreSimulator（Xcode 没装好或没启动过一次）");
    NSMutableArray<NSString *> *tried = [NSMutableArray array];
    void *skh = loadSimulatorKit(dev, tried);
    if (!skh) fail([NSString stringWithFormat:@"找不到 SimulatorKit（这个版本的 Xcode 可能还不支持），找过：%@", [tried componentsJoinedByString:@"、"]]);
    mouseMessage = (MouseFn)dlsym(skh, "IndigoHIDMessageForMouseNSEvent");
    buttonMessage = (ButtonFn)dlsym(skh, "IndigoHIDMessageForButton");
    keyboardMessage = (KeyboardFn)dlsym(skh, "IndigoHIDMessageForKeyboardArbitrary");
    if (!mouseMessage || !buttonMessage || !keyboardMessage) fail(@"这个版本的 Xcode 里没有要用的 IndigoHIDMessage 函数");

    device = findDevice(dev, @(argv[2]));
    if (!device) fail(@"找不到这台模拟器");
    // 一台模拟器有好几个显示端口：外接屏是 display class 1，折叠机（iPhone Duo）有两块 class 0 的屏（外屏、内屏），
    // 两块都有帧缓冲，没点亮的那块是全黑的；电源状态、背光这些属性两块一样，看不出哪块亮着（2026-11-26 Xcode 27.1 iOS 27.1 实测）。
    // 所以两块都订帧：只有点亮的屏会出新帧，哪块出了新帧就推哪块（开合铰链后跟着换）。刚连上画面静止时先取不是全黑的那块。
    // 刚开机时还没有帧缓冲，等一会儿（2026-11-21 实测 iPhone Duo）
    NSMutableArray *screens = [NSMutableArray array];
    for (int tries = 0; !screens.count && tries < 40; tries++) {
      for (id port in CALL(CALL(device, "io"), "ioPorts")) {
        id desc = CALL(port, "descriptor");
        if (![desc respondsToSelector:sel_registerName("framebufferSurface")] ||
            ![desc respondsToSelector:sel_registerName("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:")]) continue;
        if (((uint16_t (*)(id, SEL))objc_msgSend)(CALL(desc, "state"), sel_registerName("displayClass")) != 0) continue;
        if (!CALL(desc, "framebufferSurface")) continue;
        [screens addObject:desc];
      }
      if (!screens.count) usleep(250000);
    }
    if (!screens.count) fail(@"模拟器没有屏幕（没开机？）");
    for (NSUInteger i = 0; i < screens.count; i++)
      if (!surfaceBlank((__bridge IOSurfaceRef)CALL(screens[i], "framebufferSurface"))) { screenPort = screens[i]; screenIndex = i; break; }
    if (!screenPort) screenPort = screens.firstObject;
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    for (id desc in screens) {
      id props = [desc respondsToSelector:sel_registerName("screenProperties")] ? CALL(desc, "screenProperties") : nil;
      [names addObject:[CALL(props, "name") description] ?: @""];
    }
    screenNames = names;
    xpc_object_t motion = coreDevice(@"com.apple.coredevice.feature.monitormotion", "com.apple.coredevice.action.querymotioncapabilities");
    deviceMotion = motion && xpc_dictionary_get_bool(motion, "deviceMotionState");
    hingeAngle = motion && xpc_dictionary_get_bool(motion, "hingeAngle");
    mach_port_t purple = deviceMotion ? MACH_PORT_NULL : simLookup(@"PurpleWorkspacePort");
    canRotate = deviceMotion || purple != MACH_PORT_NULL;
    if (purple) mach_port_deallocate(mach_task_self(), purple);
    NSError *e = nil;
    // 必须给会话重置回调：initWithDevice:error: 不给，模拟器那边的 HID 会话一重置，SimulatorKit 就调空指针崩掉（2026-11-21 实测）
    hidClient = ((id (*)(id, SEL, id, id, NSError **, id))objc_msgSend)([objc_getClass("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") alloc],
        sel_registerName("initWithDevice:sessionResetQueue:error:sessionResetHandler:"), device, inputQ, &e, ^{ touching = NO; });
    if (!hidClient) fail([NSString stringWithFormat:@"连不上模拟器的触摸输入：%@", e.localizedDescription]);

    for (NSUInteger i = 0; i < screens.count; i++) {
      id desc = screens[i];
      // 回调都在 encodeQ 上，screenPort 只在这里换。熄灭的屏可能还补一帧全黑，不换过去
      void (^frame)(void) = ^{
        if (desc != screenPort) {
          if (surfaceBlank((__bridge IOSurfaceRef)CALL(desc, "framebufferSurface"))) return;
          screenPort = desc;
          screenIndex = i;
          readRotation();
        }
        encodeFresh();
      };
      // 界面方向变了（开合铰链）：重读方向，按新方向出一帧
      void (^props)(void) = ^{
        if (desc != screenPort) return;
        readRotation();
        encodeFresh();
      };
      ((void (*)(id, SEL, id, id, id, id, id))objc_msgSend)(desc, sel_registerName("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"),
                                                         [NSUUID UUID], encodeQ, frame, frame, props);
    }
    // 先出一帧：画面静止时帧回调不来，页面也要能看到当前画面
    dispatch_async(encodeQ, ^{ readRotation(); encodeFresh(); });
    // 先连好 dtuhidd、查好每块屏的触摸 target，第一下点按不用等
    dispatch_async(inputQ, ^{ dtuConnect(); vendorConnect(); loadTouchTargets(); });

    // 读 stdin 会一直阻塞，放在自己的线程上，不占 GCD 的工作线程
    [NSThread detachNewThreadWithBlock:^{
      char *line = NULL; size_t cap = 0; ssize_t n;
      while ((n = getline(&line, &cap, stdin)) > 0) @autoreleasepool {
        NSDictionary *m = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:line length:(NSUInteger)n] options:0 error:nil];
        if (![m isKindOfClass:NSDictionary.class]) continue;
        NSString *t = m[@"t"];
        if ([t isEqual:@"touch"]) {
          double x = [m[@"x"] doubleValue], y = [m[@"y"] doubleValue];
          BOOL down = [m[@"down"] boolValue];
          uint64_t edge = [m[@"edge"] unsignedLongLongValue];
          dispatch_async(inputQ, ^{ touch(x, y, down, edge); });
        } else if ([t isEqual:@"button"]) {
          uint32_t source = (uint32_t)[m[@"source"] unsignedIntValue];
          BOOL down = [m[@"down"] boolValue];
          dispatch_async(inputQ, ^{ button(source, down); });
        } else if ([t isEqual:@"hidkey"]) {
          uint32_t usage = (uint32_t)[m[@"usage"] unsignedIntValue];
          BOOL down = [m[@"down"] boolValue];
          dispatch_async(inputQ, ^{ hidKey(usage, down); });
        } else if ([t isEqual:@"hinge"] && [m[@"angle"] isKindOfClass:NSNumber.class]) {
          NSNumber *angle = @(fmin(fmax([m[@"angle"] doubleValue], 0), 180));
          dispatch_async(inputQ, ^{ vendorSend(@"hinge-slider-control", @"range", angle); });
        } else if ([t isEqual:@"orient"] && [@[@"portrait", @"landscape-right", @"pud", @"landscape-left"] containsObject:m[@"value"]]) {
          NSString *value = m[@"value"];
          // Purple 的朝向编号：1 竖、2 倒、3 / 4 横。3 转出来界面是 270°，所以顺时针 90° 的 landscape-right 是 4
          // （2026-11-26 iOS 18.3 iPhone 16 Pro 的 Safari 实测；同 idb 说的 Purple 两个横向和设备朝向是反的）
          uint32_t purple = (uint32_t)[@[@"portrait", @"pud", @"landscape-left", @"landscape-right"] indexOfObject:value] + 1;
          dispatch_async(inputQ, ^{
            if (deviceMotion) vendorSend(@"orientation-picker-control", @"enum", value);
            else purpleOrient(purple);
          });
        } else if ([t isEqual:@"keyframe"]) {
          dispatch_async(encodeQ, ^{ forceKey = YES; lastConfig = nil; encodeFresh(); });
        }
      }
      dispatch_sync(outQ, ^{});
      // 最后一条抬起可能还在路上：等输入队列发完，dtuhidd 再留 80 ms（同 idb 的 drain），不然模拟器里会留一根按着的手指
      dispatch_sync(inputQ, ^{});
      if (dtu) usleep(80000);
      exit(0);
    }];
    // 主线程跑 CFRunLoop，不用 dispatch_main（dispatch_main 会让主线程 pthread_exit）
    CFRunLoopRun();
  }
}
