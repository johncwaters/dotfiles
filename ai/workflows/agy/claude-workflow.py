import asyncio
import json
import os

HOST_PATH = os.path.expanduser("~/.claude/workflows/agy/host.mjs")
HOST_LINE_LIMIT_BYTES = 64 * 1024 * 1024


async def send_to_host(host, message):
    host.stdin.write((json.dumps(message) + "\n").encode())
    await host.stdin.drain()


async def answer_agent_request(host, request):
    lane_type = request.get("agentType") or "self"
    try:
        lane_result = await agent(request["prompt"], schema=request.get("schema") or {"type": "string"}, type_name=lane_type)
    except Exception as lane_failure:
        log(f"{lane_type} agent failed: {lane_failure}")
        await send_to_host(host, {"id": request["id"], "ok": False})
        return
    await send_to_host(host, {"id": request["id"], "ok": True, "value": lane_result})


host = await asyncio.create_subprocess_exec(
    "node", HOST_PATH, args["workflow"],
    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, limit=HOST_LINE_LIMIT_BYTES,
)
pending_answers = []
workflow_result = None
has_finished = False
try:
    await send_to_host(host, {"args": args.get("args") or {}})
    async for line in host.stdout:
        message = json.loads(line)
        if message["op"] == "agent":
            pending_answers.append(asyncio.ensure_future(answer_agent_request(host, message)))
            continue
        if message["op"] == "phase":
            phase(message["name"])
            continue
        if message["op"] == "log":
            log(message["text"])
            continue
        if message["op"] == "done":
            workflow_result = message["value"]
            has_finished = True
    host_exit_code = await host.wait()
finally:
    for answer in pending_answers:
        answer.cancel()
    if host.returncode is None:
        host.kill()
if host_exit_code != 0 or not has_finished:
    raise RuntimeError(f"{args['workflow']} host exited {host_exit_code} without a result")
print(json.dumps(workflow_result))
