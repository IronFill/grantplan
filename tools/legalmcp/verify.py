import asyncio,json,os,pathlib
from mcp import ClientSession,StdioServerParameters
from mcp.client.stdio import stdio_client
async def main():
    root=pathlib.Path(__file__).resolve().parent
    import sys
    params=StdioServerParameters(command=sys.executable,args=['-B',str(root/'server.py')],env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as session:
            await session.initialize()
            tools=await session.list_tools()
            ping=await session.call_tool('ping',{})
            result=await session.call_tool('provider_layer_self_test',{'live':False})
            data=json.loads(next(c.text for c in result.content if hasattr(c,'text')))
            summary={'tools':len(tools.tools),'ping_error':ping.is_error,'selftest_error':result.is_error,'summary':data.get('summary'),'success':data.get('success')}
            print(json.dumps(summary))
            if summary['tools']!=22 or ping.is_error or result.is_error or not data.get('success'):
                raise SystemExit(1)
asyncio.run(main())
