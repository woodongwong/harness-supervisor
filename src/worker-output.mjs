// Summarize structured native output only. Never mistake a user prompt, tool
// output or an exit code for the assistant's final response.
export function summarizeWorkerOutput(text,{partial=false}={}) {
  const result={};let events;
  try { const value=JSON.parse(text);events=Array.isArray(value)?value:[value]; }
  catch { const lines=text.split("\n");if(partial)lines.shift();events=lines.flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}); }
  for(const e of events){
    if(e.type==="thread.started")result.sessionId=e.thread_id;
    if(e.type==="turn.failed"||e.is_error===true)result.failed=true;
    let reply=e.type==="item.completed"&&e.item?.type==="agent_message"?e.item.text:typeof e.result==="string"?e.result:null;
    if(e.type==="message"&&e.role==="assistant"&&Array.isArray(e.content)) {
      reply=e.content.filter(c=>["text","output_text"].includes(c.type)).map(c=>c.text??"").join("\n");
    }
    if(reply)result.reply=reply.slice(-6000);
  }
  return result;
}
