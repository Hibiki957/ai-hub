import json, queue, sys, tempfile, time, unittest
from pathlib import Path
from zcode_tui import Engine, TUI, clean, wrap, cellwidth, default_reply, model_ref, input_lines

class Tests(unittest.TestCase):
    def test_current_only_snapshot_preserves_catalog(self):
        ui=TUI.__new__(TUI);ui.models=[{'label':'Example'}];ui.running=False
        ui.snapshot({'session':{'sessionId':'test'},'settings':{'model':{'available':[], 'current':{'modelId':'example'}}}})
        self.assertEqual(ui.models,[{'label':'Example'}])
        self.assertEqual(ui.model,'example')
    def test_model_reasoning_default_without_mutation(self):
        model={'ref':{'modelId':'example'},'reasoning':{'defaultLevel':'high'}}
        self.assertEqual(model_ref(model)['options']['reasoningLevel'],'high')
        self.assertNotIn('options',model['ref'])
        model['ref']['options']={'reasoningLevel':'low'}
        self.assertEqual(model_ref(model)['options']['reasoningLevel'],'low')
    def test_protocol_and_fail_closed(self):
        fake='''import sys,json
for line in sys.stdin:
 d=json.loads(line)
 if d.get('method')=='hello':
  print(json.dumps({'id':'prefs','method':'session/requestRuntimePreferences','params':{}}),flush=True)
  p=json.loads(sys.stdin.readline());assert p['result']['askUserQuestionAutoResolutionEnabled'] is False
  print(json.dumps({'id':'confirm','method':'interaction/requestPermission','params':{'toolName':'Bash','input':{'command':'pwd'}}}),flush=True)
  r=json.loads(sys.stdin.readline());assert r['result']['decision']=='deny'
  print(json.dumps({'id':d['id'],'result':{'ok':True}}),flush=True)
'''
        with tempfile.TemporaryDirectory() as folder:
            q=queue.Queue(); e=Engine(folder,q,[sys.executable,'-u','-c',fake])
            import threading
            result=[]
            t=threading.Thread(target=lambda:result.append(e.call('hello',timeout=5)));t.start()
            try:
                kind,request=q.get(timeout=3)
                self.assertEqual(kind,'interaction')
                self.assertEqual(request['id'],'confirm')
                self.assertEqual(result,[]) # Permission must block until the user replies.
                e.reply(request['id'],{'decision':'deny'});t.join(3)
                self.assertEqual(result,[{'ok':True}])
            finally:e.close()
    def test_stream_and_final(self):
        ui=TUI.__new__(TUI);ui.sid='test';ui.stream='';ui.parts={};ui.running=True;ui.interactions=[];ui.logs=[]
        ui.activity_started=time.monotonic()-5;ui.busy=False;ui.last_turn='';ui.status='等待模型响应'
        ui.job=lambda *a:None
        self.assertIn('等待模型响应',ui.activity_line())
        self.assertNotEqual(ui.activity_line(ui.activity_started+1),ui.activity_line(ui.activity_started+1.2))
        ui.handle_event({'params':{'sessionId':'test','type':'model.streaming','payload':{'kind':'reasoning_delta','delta':'reasoning'}}})
        self.assertIn('思考中',ui.activity_line())
        self.assertNotIn('reasoning',ui.activity_line())
        ui.handle_event({'params':{'sessionId':'test','type':'model.streaming','payload':{'kind':'text_delta','delta':'你好'}}})
        self.assertIn('正在回复',ui.activity_line())
        self.assertEqual(ui.stream,'你好')
        ui.handle_event({'params':{'sessionId':'test','type':'tool.updated','payload':{'kind':'scheduled','toolName':'Read'}}})
        self.assertIn('执行工具：Read',ui.activity_line())
        ui.interactions=[{'method':'interaction/requestPermission'}]
        self.assertIn('/allow',ui.activity_line())
        ui.handle_event({'params':{'sessionId':'test','type':'turn.completed','payload':{'response':'你好！'}}})
        self.assertEqual(ui.logs[-1],('assistant','你好！'));self.assertFalse(ui.running)
        self.assertIn('已完成',ui.activity_line());self.assertIn('5秒',ui.activity_line())
        ui.busy=True;ui.running=True;ui.events=queue.Queue();ui.events.put(('failure','Network failed'))
        ui.process_events()
        self.assertIn('请求失败',ui.activity_line());self.assertFalse(ui.running or ui.busy)
    def test_unicode_and_control_sequences(self):
        self.assertEqual(input_lines('你好ab',4,4),(['你好','ab'],(1,2)))
        self.assertEqual(input_lines('first\nnext',6,20),(['first','next'],(1,0)))
        self.assertEqual(input_lines('1234',4,4),(['1234',''],(1,0)))
        self.assertEqual(wrap('模型选择abc',4),['模型','选择','abc'])
        self.assertEqual(cellwidth('你a'),3)
        self.assertNotIn('\x1b',clean('\x1b]52;secret\a'))
        self.assertIsNone(default_reply('interaction/requestPermission'))

if __name__=='__main__':unittest.main()
