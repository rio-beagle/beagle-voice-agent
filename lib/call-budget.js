// One hard cap from call entry/setup; accepting never extends it.
export class CallBudget {
 constructor(expire,{maxMs=180000,set=setTimeout,clear=clearTimeout}={}){Object.assign(this,{expire,maxMs,set,clear});this.timer=null;this.id=null;}
 start(id,remainingMs=this.maxMs){this.stop();this.id=id.toLowerCase();const key=this.id;this.timer=this.set(()=>{if(this.id!==key)return;this.timer=null;this.id=null;this.expire(key);},Math.max(0,Math.min(this.maxMs,remainingMs)));}
 stop(){if(this.timer!==null)this.clear(this.timer);this.timer=null;this.id=null;}
}
