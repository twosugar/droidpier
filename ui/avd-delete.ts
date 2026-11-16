/** 设备在运行（含无法接管的）或开机中：能“停止运行”，删除时网关要先停掉它（模拟器正开着它的数据目录）。 */
export function deviceLive(avd: { running: "grpc" | "no-grpc" | "no" }, booting: boolean): boolean {
  return avd.running !== "no" || booting;
}
