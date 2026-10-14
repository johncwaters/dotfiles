hs.autoLaunch(true)

local configDirectory = hs.fs.pathToAbsolute(debug.getinfo(1, "S").source:sub(2)):match("(.*/)")
package.path = configDirectory .. "?.lua;" .. package.path

local microphone = require("microphone")
local calls = require("calls")
local presence = require("presence")
local lock = require("lock")

microphone.start()
calls.start(microphone)
presence.start(configDirectory .. "home-networks.local", calls)
lock.start(microphone, presence)
