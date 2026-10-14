local presence = {}

local awayIdleLockSeconds = 120
local idleCheckIntervalSeconds = 10

local calls = nil
local homeNetworkNames = {}
local wifiWatcher = nil
local idleLockTimer = nil

local function readHomeNetworkNames(path)
  local networkNames = {}
  local file = io.open(path, "r")
  if not file then
    hs.alert.show("No " .. path .. ", every network counts as away", 6)
    return networkNames
  end
  for line in file:lines() do
    local networkName = line:match("^%s*(.-)%s*$")
    if networkName ~= "" and not networkName:match("^#") then
      networkNames[networkName] = true
    end
  end
  file:close()
  return networkNames
end

function presence.isAtHome()
  local networkName = hs.wifi.currentNetwork()
  return networkName ~= nil and homeNetworkNames[networkName] == true
end

local function applySleepPolicy()
  hs.caffeinate.set("systemIdle", presence.isAtHome())
end

local function lockIfIdleAway()
  if presence.isAtHome() or calls.isActive() then
    return
  end
  if hs.host.idleTime() < awayIdleLockSeconds then
    return
  end
  if hs.caffeinate.sessionProperties().CGSSessionScreenIsLocked then
    return
  end
  hs.caffeinate.lockScreen()
end

function presence.start(homeNetworksPath, callsModule)
  calls = callsModule
  homeNetworkNames = readHomeNetworkNames(homeNetworksPath)
  wifiWatcher = hs.wifi.watcher.new(applySleepPolicy):start()
  idleLockTimer = hs.timer.doEvery(idleCheckIntervalSeconds, lockIfIdleAway)
  applySleepPolicy()
end

return presence
