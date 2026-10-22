local presence = {}

local awayIdleLockSeconds = 120
local idleCheckIntervalSeconds = 10
local workdayStartHour = 5
local workdayEndHour = 19

local calls = nil
local homeNetworkNames = {}
local wifiWatcher = nil
local idleCheckTimer = nil

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

local function isWorkingHours()
  local now = os.date("*t")
  local isWeekend = now.wday == 1 or now.wday == 7
  return not isWeekend and now.hour >= workdayStartHour and now.hour < workdayEndHour
end

local function applySleepPolicy()
  hs.caffeinate.set("systemIdle", presence.isAtHome() and isWorkingHours())
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

local function onIdleCheckTick()
  applySleepPolicy()
  lockIfIdleAway()
end

function presence.start(homeNetworksPath, callsModule)
  calls = callsModule
  homeNetworkNames = readHomeNetworkNames(homeNetworksPath)
  wifiWatcher = hs.wifi.watcher.new(applySleepPolicy):start()
  idleCheckTimer = hs.timer.doEvery(idleCheckIntervalSeconds, onIdleCheckTick)
  applySleepPolicy()
end

return presence
