import queue,time
from pathlib import Path
from zcode_tui import Engine
q=queue.Queue();e=Engine(str(Path(__file__).parent),q)
try:
 w={'workspacePath':str(Path(__file__).parent),'workspaceKey':str(Path(__file__).parent)}
 s=e.call('session/create',{'workspace':w,'mode':'build','titleGenerationEnabled':False})
 sid=s['session']['sessionId'];print('Created session; models:',len(s['settings']['model']['available']),flush=True)
 e.call('session/subscribe',{'sessionId':sid,'deliveryKind':'desktop-continuous'})
 # Use existing configured default; this smoke prompt asks for no tool actions.
 e.call('session/send',{'sessionId':sid,'content':'仅回复 ZCODE_TUI_OK。不要调用工具，不要读写文件。'})
 end=time.time()+90;types=set()
 while time.time()<end:
  try: kind,v=q.get(timeout=1)
  except queue.Empty:continue
  if kind=='interaction':
   if v['method']=='interaction/requestPermission':e.reply(v['id'],{'decision':'deny','reason':'Smoke test does not permit tool actions'})
   else:e.reply(v['id'],{'action':'decline'})
  if kind=='event':
   p=v.get('params',{});t=p.get('type','')
   if t and t not in types: print('Event:',v['method'],t,'payload keys',list((p.get('payload') or {}).keys()),flush=True);types.add(t)
   if t in ('turn.completed','turn.failed'):
    print('Completion:',p.get('payload'),flush=True);break
 result=e.call('session/read',{'sessionId':sid})
 for m in result.get('messages',[]):
  print('Message:',m.get('info',{}).get('role'),[(p.get('type'),p.get('text','')[:250]) for p in m.get('parts',[])],flush=True)
 texts=[p.get('text','') for m in result.get('messages',[]) if m.get('info',{}).get('role')=='assistant' for p in m.get('parts',[]) if p.get('type')=='text']
 assert any('ZCODE_TUI_OK' in t for t in texts), 'No successful reply received'
 assert 'turn.completed' in types, 'Turn did not complete'
 print('PASS: real reply and turn completion; session',sid,flush=True)
finally:e.close()
