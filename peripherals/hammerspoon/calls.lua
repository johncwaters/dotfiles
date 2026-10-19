local calls = {}

local pollIntervalSeconds = 2
local callEndGraceSeconds = 10

local microphone = nil
local isCallActive = false
local secondsSinceMicrophoneReleased = 0
local microphonePollTimer = nil

local function pollMicrophone()
  if microphone.isInUse() then
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

function calls.start(microphoneModule)
  microphone = microphoneModule
  microphonePollTimer = hs.timer.doEvery(pollIntervalSeconds, pollMicrophone)
  pollMicrophone()
end

return calls
