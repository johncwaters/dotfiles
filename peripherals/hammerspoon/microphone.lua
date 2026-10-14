local microphone = {}

local fallbackUnmutedVolume = 75
local unmutedVolumeByMicrophoneUid = {}
local wasMutedBeforePushToTalk = nil
local microphoneIndicator = nil
local defaultInputChangedCallbacks = {}

local function isDeviceMuted(device)
  local muteState = device:inputMuted()
  if muteState ~= nil then
    return muteState
  end
  return device:inputVolume() == 0
end

local function setDeviceMuted(device, shouldMute)
  if device:setInputMuted(shouldMute) then
    return
  end
  if shouldMute then
    unmutedVolumeByMicrophoneUid[device:uid()] = device:inputVolume()
    device:setInputVolume(0)
    return
  end
  device:setInputVolume(unmutedVolumeByMicrophoneUid[device:uid()] or fallbackUnmutedVolume)
end

local function refreshIndicator()
  local device = hs.audiodevice.defaultInputDevice()
  if not device then
    microphoneIndicator:setTitle("no mic")
    return
  end
  microphoneIndicator:setTitle(isDeviceMuted(device) and "🔇" or "🎙️")
  microphoneIndicator:setTooltip(device:name())
end

function microphone.isMuted()
  local device = hs.audiodevice.defaultInputDevice()
  return device == nil or isDeviceMuted(device)
end

function microphone.isInUse()
  local device = hs.audiodevice.defaultInputDevice()
  return device ~= nil and device:inUse()
end

function microphone.setMuted(shouldMute)
  local device = hs.audiodevice.defaultInputDevice()
  if not device then
    return
  end
  setDeviceMuted(device, shouldMute)
  refreshIndicator()
end

local function toggleMute()
  if not hs.audiodevice.defaultInputDevice() then
    hs.alert.show("No microphone")
    return
  end
  local shouldMute = not microphone.isMuted()
  microphone.setMuted(shouldMute)
  hs.alert.closeAll()
  hs.alert.show(shouldMute and "Mic muted" or "Mic live", 0.6)
end

local function startPushToTalk()
  wasMutedBeforePushToTalk = microphone.isMuted()
  microphone.setMuted(false)
end

local function endPushToTalk()
  if wasMutedBeforePushToTalk == nil then
    return
  end
  microphone.setMuted(wasMutedBeforePushToTalk)
  wasMutedBeforePushToTalk = nil
end

function microphone.onDefaultInputChanged(callback)
  table.insert(defaultInputChangedCallbacks, callback)
end

function microphone.start()
  microphoneIndicator = hs.menubar.new()
  -- The GTK01 macro key sends F19 on tap and holds F18, from the Vial layout's TD(0).
  hs.hotkey.bind({}, "f19", toggleMute)
  hs.hotkey.bind({}, "f18", startPushToTalk, endPushToTalk)
  hs.audiodevice.watcher.setCallback(function(event)
    if event ~= "dIn " then
      return
    end
    for _, callback in ipairs(defaultInputChangedCallbacks) do
      callback()
    end
    refreshIndicator()
  end)
  hs.audiodevice.watcher.start()
  refreshIndicator()
end

return microphone
