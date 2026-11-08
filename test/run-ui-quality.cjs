const {spawnSync}=require('node:child_process'),path=require('node:path');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const result=spawnSync(require('electron'),[path.join(__dirname,'ui-quality.cjs'),...process.argv.slice(2)],{env,windowsHide:true,encoding:'utf8',timeout:140000});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');if(result.error)console.error(result.error);process.exitCode=result.status ?? 1;
