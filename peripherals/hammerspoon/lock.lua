local lock = {}

local presence = nil
local wasSpeakerMutedBeforeLock = nil
local screenLockWatcher = nil

local function onScreenLocked()
  local speaker = hs.audiodevice.defaultOutputDevice()
  if presence.isAtHome() or not speaker then
    return
  end
  wasSpeakerMutedBeforeLock = speaker:outputMuted()
  speaker:setOutputMuted(true)
end

local function onScreenUnlocked()
  local speaker = hs.audiodevice.defaultOutputDevice()
  if speaker and wasSpeakerMutedBeforeLock ~= nil then
    speaker:setOutputMuted(wasSpeakerMutedBeforeLock)
  end
  wasSpeakerMutedBeforeLock = nil
end

function lock.start(presenceModule)
  presence = presenceModule
  screenLockWatcher = hs.caffeinate.watcher.new(function(event)
    if event == hs.caffeinate.watcher.screensDidLock then
      onScreenLocked()
      return
    end
    if event == hs.caffeinate.watcher.screensDidUnlock then
      onScreenUnlocked()
    end
  end):start()
end

return lock
