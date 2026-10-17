// Fallback trace parser, used only if the AI-written one never passes its test.
// Same input/output contract as the one the agent asks the LLM to write.
export const BUILTIN_ANALYZER = String.raw`
import json, re, sys

line_re = re.compile(r'^(\d+)\s+(.*)$')
open_re = re.compile(r'openat\([^,]+,\s*"([^"]*)"')
conn_re = re.compile(r'connect\(\d+,\s*\{sa_family=AF_INET6?,\s*sin6?_port=htons\((\d+)\).*?(?:inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6,\s*"([^"]+)")')
exec_re = re.compile(r'execve\("[^"]*",\s*\[(.*?)\]')

commands, files, conns, seen = {}, [], [], set()
last_cmd = ""
pending = {}

for raw in open(sys.argv[1], errors="replace"):
    m = line_re.match(raw.rstrip("\n"))
    if not m:
        continue
    pid, body = int(m.group(1)), m.group(2)
    if "<unfinished ...>" in body:
        pending[pid] = body.split("<unfinished ...>")[0]
        continue
    if body.startswith("<..."):
        body = pending.pop(pid, "") + body.split(">", 1)[-1]
    if pid not in commands:
        commands[pid] = last_cmd
    e = exec_re.search(body)
    if e and not re.search(r'=\s*-1', body):
        commands[pid] = " ".join(re.findall(r'"([^"]*)"', e.group(1)))
        last_cmd = commands[pid]
        continue
    o = open_re.search(body)
    if o and o.group(1).startswith("/") and (o.group(1), pid) not in seen:
        seen.add((o.group(1), pid))
        files.append({"path": o.group(1), "pid": pid, "command": commands[pid]})
        continue
    c = conn_re.search(body)
    if c:
        conns.append({"ip": c.group(2) or c.group(3), "port": int(c.group(1)), "pid": pid, "command": commands[pid]})

print(json.dumps({"files": files, "connections": conns}))
`;
