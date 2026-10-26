local calls = {}

local pollIntervalSeconds = 2
local callEndGraceSeconds = 10

local isCallActive = false
local secondsSinceMicrophoneReleased = 0
local microphonePollTimer = nil

local function isMicrophoneInUse()
  local device = hs.audiodevice.defaultInputDevice()
  return device ~= nil and device:inUse()
end

local function pollMicrophone()
  if isMicrophoneInUse() then
    secondsSinceMicrophoneReleased = 0
    isCallActive = true
    return
  end
  if not isCallActive then
    return
  end
  secondsSinceMicrophoneReleased = secondsSinceMicrophoneReleased + pollIntervalSeconds
  if secondsSinceMicrophoneReleased >= callEndGraceSeconds then
    isCallActive = false
  end
end

function calls.isActive()
  return isCallActive
end

function calls.start()
  microphonePollTimer = hs.timer.doEvery(pollIntervalSeconds, pollMicrophone)
  pollMicrophone()
end

return calls
