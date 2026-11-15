SHELL := /bin/bash

# Read only the values make needs from .env. Node loads the rest itself.
env_value = $(shell sed -n 's/^$(1)=//p' .env 2>/dev/null | tail -n 1)

PORT      ?= $(or $(call env_value,PORT),3000)
NGROK_URL ?= $(call env_value,NGROK_URL)

# Finds the public URL of the tunnel pointing at TUNNEL_PORT. Checks each ngrok
# inspector port, since another ngrok may already hold the default 4040.
TUNNEL_URL_JS = for (const p of [4040,4041,4042,4043,4044,4045]) { try { const { tunnels } = await (await fetch("http://127.0.0.1:" + p + "/api/tunnels")).json(); const t = tunnels.find((t) => t.public_url.startsWith("https") && t.config.addr.endsWith(":" + process.env.TUNNEL_PORT)); if (t) { console.log(t.public_url); break; } } catch {} }

.PHONY: start dev typecheck

start: APP := npm start
dev:   APP := npm run dev

# Runs Phrax and an ngrok tunnel to it. Ctrl-C stops both; if either one
# exits, the other is stopped too.
start dev: node_modules
	@command -v ngrok >/dev/null || { echo "ngrok is not installed: brew install ngrok"; exit 1; }
	@if lsof -nP -iTCP:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "Port $(PORT) is already in use. Stop the other process or set PORT."; exit 1; \
	fi
	@if pgrep -f 'ngrok http' >/dev/null; then \
	  echo "Note: another ngrok is already running: $$(pgrep -fl 'ngrok http' | head -n 1)"; \
	fi
	@trap 'kill $$app $$tunnel 2>/dev/null; wait 2>/dev/null' EXIT; \
	trap 'exit 130' INT TERM; \
	$(APP) & app=$$!; \
	ngrok http $(if $(NGROK_URL),--url=$(NGROK_URL)) $(PORT) --log=stderr --log-level=error >/dev/null & tunnel=$$!; \
	url=""; \
	for i in $$(seq 1 30); do \
	  url=$$(TUNNEL_PORT=$(PORT) node --input-type=module -e '$(TUNNEL_URL_JS)'); \
	  [ -n "$$url" ] && break; \
	  kill -0 $$tunnel 2>/dev/null || break; \
	  sleep 0.5; \
	done; \
	if [ -n "$$url" ]; then \
	  echo ""; echo "  ngrok tunnel:      $$url -> localhost:$(PORT)"; \
	  echo "  Slack Request URL: $$url/slack/events"; echo ""; \
	else \
	  echo "ngrok did not report a public URL. Run 'ngrok http $(PORT)' by hand to see why."; \
	fi; \
	while kill -0 $$app 2>/dev/null && kill -0 $$tunnel 2>/dev/null; do sleep 1; done; \
	kill -0 $$app 2>/dev/null && echo "ngrok exited; stopping Phrax." || echo "Phrax exited; stopping ngrok."; \
	exit 1

node_modules: package.json package-lock.json
	npm install
	@touch node_modules

typecheck: node_modules
	npm run typecheck
