hs.autoLaunch(true)

local fallbackUnmutedVolume = 75
local unmutedVolumeByMicrophoneUid = {}
local wasMutedBeforePushToTalk = nil
local microphoneIndicator = hs.menubar.new()

local function isMicrophoneMuted(microphone)
  local muteState = microphone:inputMuted()
  if muteState ~= nil then
    return muteState
  end
  return microphone:inputVolume() == 0
end

local function setMicrophoneMuted(microphone, shouldMute)
  if microphone:setInputMuted(shouldMute) then
    return
  end
  if shouldMute then
    unmutedVolumeByMicrophoneUid[microphone:uid()] = microphone:inputVolume()
    microphone:setInputVolume(0)
    return
  end
  microphone:setInputVolume(unmutedVolumeByMicrophoneUid[microphone:uid()] or fallbackUnmutedVolume)
end

local function refreshMicrophoneIndicator()
  local microphone = hs.audiodevice.defaultInputDevice()
  if not microphone then
    microphoneIndicator:setTitle("no mic")
    return
  end
  microphoneIndicator:setTitle(isMicrophoneMuted(microphone) and "🔇" or "🎙️")
  microphoneIndicator:setTooltip(microphone:name())
end

local function toggleMicrophoneMute()
  local microphone = hs.audiodevice.defaultInputDevice()
  if not microphone then
    hs.alert.show("No microphone")
    return
  end
  local shouldMute = not isMicrophoneMuted(microphone)
  setMicrophoneMuted(microphone, shouldMute)
  refreshMicrophoneIndicator()
  hs.alert.closeAll()
  hs.alert.show(shouldMute and "Mic muted" or "Mic live", 0.6)
end

local function startPushToTalk()
  local microphone = hs.audiodevice.defaultInputDevice()
  if not microphone then
    return
  end
  wasMutedBeforePushToTalk = isMicrophoneMuted(microphone)
  setMicrophoneMuted(microphone, false)
  refreshMicrophoneIndicator()
end

local function endPushToTalk()
  local microphone = hs.audiodevice.defaultInputDevice()
  if not microphone or wasMutedBeforePushToTalk == nil then
    return
  end
  setMicrophoneMuted(microphone, wasMutedBeforePushToTalk)
  wasMutedBeforePushToTalk = nil
  refreshMicrophoneIndicator()
end

-- The GTK01 macro key sends F19 on tap and holds F18, from the Vial layout's TD(0).
hs.hotkey.bind({}, "f19", toggleMicrophoneMute)
hs.hotkey.bind({}, "f18", startPushToTalk, endPushToTalk)

hs.audiodevice.watcher.setCallback(function(event)
  if event == "dIn " then
    refreshMicrophoneIndicator()
  end
end)
hs.audiodevice.watcher.start()
refreshMicrophoneIndicator()
