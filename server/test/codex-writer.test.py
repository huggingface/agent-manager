import importlib.util,pathlib,tempfile,uuid,fcntl,os,sqlite3,unittest
spec=importlib.util.spec_from_file_location('writer',pathlib.Path(__file__).resolve().parents[2]/'scripts/codex-writer.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class WriterTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.home=pathlib.Path(self.tmp.name);self.tid=str(uuid.uuid4());(self.home/'thread-writer-locks').mkdir();self.lock=self.home/'thread-writer-locks'/(self.tid+'.lock')
 def tearDown(self):self.tmp.cleanup()
 def test_free_held_and_inode_preserved(self):
  self.assertEqual(mod.inspect(self.home,self.tid)['state'],'absent');self.lock.touch();ino=self.lock.stat().st_ino
  self.assertEqual(mod.inspect(self.home,self.tid)['state'],'free')
  with self.lock.open('r') as f:
   fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);owner=mod.inspect(self.home,self.tid);self.assertEqual(owner['state'],'held');self.assertEqual(owner['pid'],os.getpid());self.assertIn('startTicks',owner)
  self.assertEqual(self.lock.stat().st_ino,ino);self.assertEqual(mod.inspect(self.home,self.tid)['state'],'free')
 def test_symlink_and_unverified_schema_refused(self):
  target=self.home/'target';target.touch();self.lock.symlink_to(target);self.assertEqual(mod.inspect(self.home,self.tid)['state'],'unknown')
  with self.assertRaises(ValueError):mod.pending(self.home,self.tid)
 def test_goals_and_queue_are_read_only(self):
  db=sqlite3.connect(self.home/'state.sqlite');db.executescript('CREATE TABLE thread_goals(thread_id TEXT,status TEXT); CREATE TABLE queued_items(thread_id TEXT,queue_order INTEGER,payload_json TEXT);');db.commit()
  self.assertEqual(mod.pending(self.home,self.tid),{'activeGoal':False,'queuedInput':False})
  db.execute('INSERT INTO thread_goals VALUES (?,?)',(self.tid,'active'));db.execute('INSERT INTO queued_items VALUES (?,0,?)',(self.tid,'{}'));db.commit()
  self.assertEqual(mod.pending(self.home,self.tid),{'activeGoal':True,'queuedInput':True});self.assertEqual(db.execute('SELECT COUNT(*) FROM queued_items').fetchone()[0],1);db.close()
if __name__=='__main__':unittest.main()
