#!/usr/bin/env python3
"""Inspect one Linux Codex writer lock. Never signal, unlink, or create a lock."""
import fcntl,json,os,re,stat,sys,sqlite3
from pathlib import Path

def inspect(home,tid):
    if sys.platform!='linux' or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',tid):
        return {'state':'unknown'}
    directory=Path(home).resolve()/'thread-writer-locks'
    if directory.is_symlink() or not directory.is_dir():return {'state':'unknown'}
    lock=directory/(tid+'.lock')
    try:
        s=lock.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid():return {'state':'unknown'}
        owners=[]
        for line in Path('/proc/locks').read_text().splitlines():
            x=line.split()
            if len(x)!=8 or x[1]!='FLOCK' or x[3]!='WRITE':continue
            a,b,i=x[5].split(':')
            if (int(a,16),int(b,16),int(i))==(os.major(s.st_dev),os.minor(s.st_dev),s.st_ino):owners.append(int(x[4]))
        if len(owners)==1 and owners[0]>0:
            pid=owners[0];p=Path('/proc')/str(pid);raw=(p/'stat').read_text();fields=raw[raw.rindex(')')+2:].split()
            if p.stat().st_uid!=os.getuid() or fields[0]=='Z':return {'state':'unknown'}
            argv=(p/'cmdline').read_bytes().split(b'\0')
            return {'state':'held','pid':pid,'startTicks':fields[19],'daemon':b'app-server' in argv}
        if owners:return {'state':'unknown'}
        # A hidden namespace owner must not be mistaken for a stale/free lock.
        fd=os.open(lock,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            fs=os.fstat(fd)
            if (fs.st_dev,fs.st_ino)!=(s.st_dev,s.st_ino):return {'state':'unknown'}
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:return {'state':'unknown'}
            fcntl.flock(fd,fcntl.LOCK_UN)
            return {'state':'free'}
        finally:os.close(fd)
    except FileNotFoundError:
        return {'state':'absent'} if not lock.exists() else {'state':'unknown'}
    except (OSError,ValueError,IndexError):return {'state':'unknown'}

def pending(home,tid):
    found={}
    for file in Path(home).resolve().glob('*.sqlite'):
        with sqlite3.connect(file.resolve().as_uri()+'?mode=ro',uri=True,timeout=2) as db:
            db.execute('PRAGMA query_only=ON')
            for table,required in [('thread_goals',{'thread_id','status'}),('queued_items',{'thread_id','queue_order','payload_json'})]:
                columns={row[1] for row in db.execute('PRAGMA table_info('+table+')')}
                if required<=columns:
                    if table in found:raise ValueError('ambiguous schema')
                    query='SELECT 1 FROM '+table+' WHERE thread_id=?'+(" AND status='active'" if table=='thread_goals' else '')+' LIMIT 1'
                    found[table]=db.execute(query,(tid,)).fetchone() is not None
    if len(found)!=2:raise ValueError('unverified queue schema')
    return {'activeGoal':found['thread_goals'],'queuedInput':found['queued_items']}

if __name__=='__main__':
    try:result={**inspect(sys.argv[1],sys.argv[2]),**pending(sys.argv[1],sys.argv[2])}
    except Exception:result={'state':'unknown'}
    print(json.dumps(result))
