import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export class LocalBackend {
  constructor({ log = () => {}, timeoutMs = 90000, env = {} } = {}) {
    this.pending = new Map(); this.seq = 0; this.timeoutMs = timeoutMs; this.closed = false;
    this.process = spawn(path.join(root,'.venv/bin/python'), ['-u',path.join(root,'local-worker.py')], {cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,...env}});
    this.process.stderr.on('data', b => log('local-worker',b.toString().trim()));
    this.ready = new Promise((resolve,reject) => { this.readyResolve=resolve; this.readyReject=reject; });
    this.startupTimer=setTimeout(()=>this.fail(new Error('local model startup timed out')),120000);
    createInterface({input:this.process.stdout}).on('line', line => {
      let d; try { d=JSON.parse(line); } catch { return; }
      if ('ready' in d) { clearTimeout(this.startupTimer); d.ready ? this.readyResolve() : this.fail(new Error(d.error)); return; }
      const p=this.pending.get(d.id); if (!p) return; if (d.partial) { try { p.onPartial?.(d); } catch {} return; } this.pending.delete(d.id); clearTimeout(p.timer); d.error ? p.reject(new Error(d.error)) : p.resolve(d);
    });
    this.process.on('error',e=>this.fail(e)); this.process.on('exit',()=>this.fail(new Error('local worker exited')));
  }
  fail(e) { this.readyReject(e); clearTimeout(this.startupTimer); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); this.closed=true; this.process.kill(); }
  async request(data, { onPartial } = {}) {
    await this.ready; if (this.closed) throw new Error('backend closed');
    if (this.pending.size >= 2) throw new Error('backend busy');
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(new Error('local inference timed out')),this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer,onPartial});
      this.process.stdin.write(JSON.stringify({...data,id})+'\n',e=>{if(e)this.fail(e);});
    });
  }
  close() { this.fail(new Error('backend closed')); }
}
