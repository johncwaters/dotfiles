local calls = {}

local pollIntervalSeconds = 2
local callEndGraceSeconds = 10

local microphone = nil
local isCallActive = false
local wasMicrophoneMutedBeforeCall = false
local secondsSinceMicrophoneReleased = 0
local microphonePollTimer = nil

local function startCall()
  isCallActive = true
  wasMicrophoneMutedBeforeCall = microphone.isMuted()
  microphone.setMuted(true)
  hs.alert.show("Call started, mic muted", 1)
end

local function endCall()
  isCallActive = false
  microphone.setMuted(wasMicrophoneMutedBeforeCall)
end

local function pollMicrophone()
  if microphone.isInUse() then
    secondsSinceMicrophoneReleased = 0
    if not isCallActive then
      startCall()
    end
    return
  end
  if not isCallActive then
    return
  end
  secondsSinceMicrophoneReleased = secondsSinceMicrophoneReleased + pollIntervalSeconds
  if secondsSinceMicrophoneReleased >= callEndGraceSeconds then
    endCall()
  end
end

function calls.isActive()
  return isCallActive
end

function calls.start(microphoneModule)
  microphone = microphoneModule
  microphone.onDefaultInputChanged(function()
    if isCallActive then
      microphone.setMuted(true)
    end
  end)
  microphonePollTimer = hs.timer.doEvery(pollIntervalSeconds, pollMicrophone)
  pollMicrophone()
end

return calls
