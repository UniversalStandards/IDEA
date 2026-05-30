# universalstandards-hub

Python SDK for Universal MCP Orchestration Hub.

## Install

```bash
pip install universalstandards-hub
```

## Quickstart

```python
import os
from universalstandards_hub import HubClient

hub = HubClient(base_url="https://hub.spurs.gov", api_key=os.environ["HUB_KEY"])

caps = hub.capabilities.search("filesystem")
print(caps.count)
```

## Async workflow streaming

```python
import os
import asyncio
from universalstandards_hub import HubClient

async def main() -> None:
    async with HubClient(base_url="https://hub.spurs.gov", api_key=os.environ["HUB_KEY"]) as hub:
        async with hub.workflows.run_stream("analyze-docs", input={"path": "/data"}) as stream:
            async for event in stream:
                print(event.event, event.data)

asyncio.run(main())
```

## Jupyter snippet

```python
# In a notebook cell
import os
from universalstandards_hub import HubClient

hub = HubClient(base_url="https://hub.spurs.gov", api_key=os.environ["HUB_KEY"])
providers = hub.request("GET", "/api/v1/providers")
providers
```
