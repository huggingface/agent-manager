#!/bin/bash
# End-to-end test of the remote-agent protocol against a throwaway server.
SC=/tmp/claude-1000/-data-workspaces-agent-manager/bb5087f8-c501-4fae-ba56-6c57f9ab745e/scratchpad
B=localhost:7901
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  PASS  $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL  $1"; echo "        got: $2"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2 (want $3)"; fi; }

echo "== 1. creation (the §8 flow: name it, queue a task) =="
R=$(curl -s -X POST -H 'content-type: application/json' \
  -d '{"cli":"remote","name":"laptop","prompt":"have a look at the failing test in trl/trainer"}' $B/api/sessions)
ID=$(echo "$R" | jq -r .id)
check "path is remote-agents/<slug>" "$(echo "$R" | jq -r .path)" "remote-agents/laptop"
check "remote slug minted"          "$(echo "$R" | jq -r .remote.name)" "laptop"
check "queued prompt is seq 1"      "$(curl -s $B/api/remote/laptop/ping | jq -r .seq)" "1"
check "first message is on disk"    "$(ls $SC/td3/workspaces/remote-agents/laptop/ | tr '\n' ' ')" "00001-user.md README.md "

echo "== 2. ping does not fake liveness (nothing is polling yet) =="
check "state before any poll" "$(curl -s $B/api/tree | jq -r '.sessions[]|select(.cli=="remote")|.state')" "stopped"

echo "== 3. hello + the blocking stream returns queued work IMMEDIATELY =="
curl -s -X POST -H 'content-type: application/json' \
  -d '{"harness":"claude","cwd":"~/src/trl","host":"macbook"}' $B/api/remote/laptop/hello >/dev/null
S=$(date +%s)
OUT=$(curl -s -N --max-time 30 "$B/api/remote/laptop/stream?since=0&wait=20")
EL=$(( $(date +%s) - S ))
check "returned at once, not after wait" "$([ $EL -le 3 ] && echo fast || echo "slow:${EL}s")" "fast"
check "first line is :connected"  "$(echo "$OUT" | head -1)" ":connected"
check "delivers the queued task"   "$(echo "$OUT" | tail -1 | jq -r '.messages[0].text')" "have a look at the failing test in trl/trainer"
check "cursor advances"            "$(echo "$OUT" | tail -1 | jq -r .seq)" "1"

echo "== 4. state while work is outstanding = working =="
check "outstanding -> working" "$(curl -s $B/api/tree | jq -r '.sessions[]|select(.cli=="remote")|.state')" "working"

echo "== 5. the agent replies; state flips to listening (waiting) =="
curl -s -X POST -H 'content-type: text/plain' --data-binary @- $B/api/remote/laptop/messages >/dev/null <<'EOF'
It's the tokenizer fixture — `pad_token` is None on the Qwen config.
EOF
check "answered -> waiting" "$(curl -s $B/api/tree | jq -r '.sessions[]|select(.cli=="remote")|.state')" "waiting"
check "agent message on disk" "$([ -f $SC/td3/workspaces/remote-agents/laptop/00003-agent.md ] && echo yes || echo no)" "yes"

echo "== 6. its own words are never echoed back to it =="
check "since=1 gives the agent nothing" \
  "$(curl -s "$B/api/remote/laptop/messages?since=1&agent=1" | jq -r '.messages|length')" "0"
check "but the UI sees all of it" \
  "$(curl -s "$B/api/sessions/$ID/remote" | jq -r '.messages|length')" "3"

echo "== 7. a wait that expires returns empty (the normal idle state) =="
S=$(date +%s)
OUT=$(curl -s -N --max-time 20 "$B/api/remote/laptop/stream?since=9&wait=5")
EL=$(( $(date +%s) - S ))
check "waited ~5s"        "$([ $EL -ge 4 ] && [ $EL -le 9 ] && echo yes || echo "no:${EL}s")" "yes"
check "empty, not an error" "$(echo "$OUT" | tail -1 | jq -r '.messages|length')" "0"

echo "== 8. the Overview reply box reaches a remote agent (deliver shim) =="
curl -s -X POST -H 'content-type: application/json' -d '{"text":"fix it and run the suite"}' $B/api/sessions/$ID/input >/dev/null
check "delivered as a user message" \
  "$(curl -s "$B/api/remote/laptop/messages?since=3&agent=1" | jq -r '.messages[0].text')" "fix it and run the suite"
check "attributed to the operator" \
  "$(curl -s "$B/api/remote/laptop/messages?since=3&agent=1" | jq -r '.messages[0].from')" "lvwerra"

echo "== 9. an in-Space agent can message the laptop (agent-to-agent, free) =="
curl -s -X POST -H 'content-type: application/json' -d '{"cli":"shell","name":"helper"}' $B/api/sessions >/dev/null
H=$(curl -s $B/api/tree | jq -r '.sessions[]|select(.name=="helper")|.id')
curl -s -X POST -H 'content-type: text/plain' --data-binary 'can you check the tokenizer too?' \
  "$B/api/agents/$ID/prompt?from=$H" >/dev/null
check "peer prefix preserved" \
  "$(curl -s "$B/api/remote/laptop/messages?since=4&agent=1" | jq -r '.messages[0].text')" "[message from helper:] can you check the tokenizer too?"
check "peer recorded in from:" \
  "$(curl -s "$B/api/remote/laptop/messages?since=4&agent=1" | jq -r '.messages[0].from')" "helper"

echo "== 10. Disconnect closes an OPEN poll at once (not at the end of wait) =="
( curl -s -N --max-time 40 "$B/api/remote/laptop/stream?since=99&wait=30" > $SC/openpoll.txt ) &
sleep 2
S=$(date +%s)
curl -s -X POST -H 'content-type: application/json' -d '{"paused":true}' $B/api/sessions/$ID/remote/paused >/dev/null
wait
EL=$(( $(date +%s) - S ))
check "poll closed immediately"  "$([ $EL -le 3 ] && echo yes || echo "no:${EL}s")" "yes"
check "and it said stop:true"    "$(tail -1 $SC/openpoll.txt | jq -r .stop)" "true"
check "paused -> stopped"         "$(curl -s $B/api/tree | jq -r '.sessions[]|select(.cli=="remote")|.state')" "stopped"
check "a new poll is refused too" "$(curl -s "$B/api/remote/laptop/stream?since=0&wait=5" | jq -r .stop)" "true"
check "posting is refused"        "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: text/plain' --data-binary 'hi' $B/api/remote/laptop/messages)" "409"

echo "== 11. reconnect =="
curl -s -X POST -H 'content-type: application/json' -d '{"paused":false}' $B/api/sessions/$ID/remote/paused >/dev/null
check "unpaused, nothing polling -> stopped" "$(curl -s $B/api/tree | jq -r '.sessions[]|select(.cli=="remote")|.state')" "stopped"
check "stream works again" "$(curl -s -N --max-time 10 "$B/api/remote/laptop/stream?since=0&wait=5" | tail -1 | jq -r '.messages|length>0')" "true"

echo "== 12. no terminal, no spawn, no usage inflation =="
check "/ws refuses it" "$(node -e "
import('/app/server/node_modules/ws/index.js').then(({default:pkg})=>{
  const {WebSocket}=pkg; const ws=new WebSocket('ws://$B/ws?session=$ID');
  ws.on('message',m=>{console.log(String(m).trim());process.exit(0)});
  ws.on('error',()=>{console.log('error');process.exit(0)});
  setTimeout(()=>{console.log('timeout');process.exit(0)},5000);
})" 2>/dev/null)" "[this pane has no terminal — it talks to an agent elsewhere]"
check "not spawnable by an agent" \
  "$(curl -s -X POST -H 'content-type: text/plain' --data-binary 'go' "$B/api/agents?from=$H&cli=remote" | jq -r '.error|split(" ")[0:6]|join(" ")')" \
  "a remote agent has to be"
check "absent from the spawn catalog" \
  "$(curl -s "$B/api/agents?from=$H" | jq -r '[.clis[].id]|index("remote")')" "null"
check "excluded from token usage" \
  "$(curl -s $B/api/traces | jq -r '[.sessions[]|select(.cli=="remote")]|length')" "0"
check "but present in the Overview" \
  "$(curl -s $B/api/meta | jq -r '[.sessions[]|select(.cli=="remote")]|length')" "1"
check "with a folder-built digest" \
  "$(curl -s $B/api/meta | jq -r '.sessions[]|select(.cli=="remote")|.digest.lastAssistantText' | head -c 20)" "It's the tokenizer f"

echo
echo "  $pass passed, $fail failed"
[ $fail -eq 0 ] || exit 1
