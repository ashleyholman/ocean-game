import Foundation

struct ThermalSample: Codable {
  let capturedAt: String
  let thermalState: String
  let thermalStateRaw: Int
  let lowPowerMode: Bool
  let activeProcessorCount: Int
}

let intervalMilliseconds = max(Int(CommandLine.arguments.dropFirst().first ?? "1000") ?? 1000, 100)
let intervalSeconds = Double(intervalMilliseconds) / 1000.0
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let encoder = JSONEncoder()

func thermalStateName(_ state: ProcessInfo.ThermalState) -> String {
  switch state {
  case .nominal: return "nominal"
  case .fair: return "fair"
  case .serious: return "serious"
  case .critical: return "critical"
  @unknown default: return "unknown"
  }
}

while true {
  let info = ProcessInfo.processInfo
  let state = info.thermalState
  let sample = ThermalSample(
    capturedAt: formatter.string(from: Date()),
    thermalState: thermalStateName(state),
    thermalStateRaw: state.rawValue,
    lowPowerMode: info.isLowPowerModeEnabled,
    activeProcessorCount: info.activeProcessorCount
  )
  if let data = try? encoder.encode(sample) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
  }
  Thread.sleep(forTimeInterval: intervalSeconds)
}
