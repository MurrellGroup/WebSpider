const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1) || '');
const state = { topics: [], topic: null, messages: [], files: [], urls: new Map(), timer: null };
const $ = (selector, root = document) => root.querySelector(selector);
const h = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);

async function api(path, options = {}) {
  const response = await fetch(`/api/v1/team-chat/guest/${path}`, {
    method: options.method || 'GET', headers: { authorization:`Bearer ${token}`, ...(options.body ? {'content-type':'application/json'} : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error?.message || `Chat request failed (${response.status})`);
  return value;
}

function toast(text, bad = false) { const el=$('#toast'); el.textContent=text; el.className=`toast${bad?' bad':''}`; clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.add('hidden'),3500); }
function name() { return ($('#display-name').value || '').trim(); }
function saveName() { localStorage.setItem('webspider_chat_name', name()); }
function initials(value) { return String(value || '?').split(/\s+/).slice(0,2).map((p)=>p[0]).join('').toUpperCase(); }
function time(value) { return new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit'}).format(new Date(value)); }

async function attachmentURL(attachment) {
  if (state.urls.has(attachment.id)) return state.urls.get(attachment.id);
  const response = await fetch(`/api/v1/team-chat/guest/attachments/${encodeURIComponent(attachment.id)}`, { headers:{authorization:`Bearer ${token}`} });
  if (!response.ok) return '';
  const url = URL.createObjectURL(await response.blob()); state.urls.set(attachment.id,url); return url;
}

async function renderMessages(scroll = false) {
  const target=$('#messages');
  const pinned = target.scrollHeight - target.scrollTop - target.clientHeight < 90;
  target.innerHTML = state.messages.map((message)=>`<article class="message ${h(message.actor_kind)}"><div class="avatar">${h(initials(message.display_name))}</div><div><div class="message-head"><strong>${h(message.display_name)}</strong><time>${h(time(message.created_at))}</time></div><div class="message-body">${h(message.body)}</div><div class="attachments">${message.attachments.map((a)=>`<a class="attachment" data-attachment-id="${h(a.id)}" ${a.mime_type==='application/pdf'?'target="_blank" rel="noopener"':`download="${h(a.filename)}"`}><span>${h(a.filename)} · ${h(Math.ceil(a.size_bytes/1024))} KB</span></a>`).join('')}</div></div></article>`).join('') || '<div class="empty">No messages yet.</div>';
  for (const link of target.querySelectorAll('[data-attachment-id]')) {
    const attachment=state.messages.flatMap((m)=>m.attachments).find((a)=>a.id===link.dataset.attachmentId);
    const url=await attachmentURL(attachment); link.href=url;
    if (/^image\/(png|jpeg|gif|webp)$/i.test(attachment.mime_type) && url) link.insertAdjacentHTML('afterbegin',`<img src="${h(url)}" alt="${h(attachment.filename)}">`);
  }
  if (scroll || pinned) target.scrollTop=target.scrollHeight;
}

async function selectTopic(id) {
  state.topic=state.topics.find((topic)=>topic.id===id); state.messages=[];
  $('#topic-name').textContent=state.topic?.name || 'Team chat'; $('#topic-description').textContent=state.topic?.description || '';
  document.querySelectorAll('.topic').forEach((button)=>button.classList.toggle('selected',button.dataset.id===id));
  $('.chat-sidebar').classList.remove('open'); await poll(true);
}

async function poll(scroll = false) {
  if (!state.topic) return;
  try {
    const after=state.messages.at(-1)?.sequence || 0;
    const result=await api(`topics/${encodeURIComponent(state.topic.id)}/messages?after=${after}`);
    if (result.messages.length) { state.messages.push(...result.messages); await renderMessages(scroll); }
  } catch (error) { toast(error.message,true); }
}

function renderDrafts() {
  const target=$('#attachment-drafts'); target.classList.toggle('hidden',!state.files.length);
  target.innerHTML=state.files.map((file,index)=>`<div class="draft">${file.type.startsWith('image/')?`<img src="${h(URL.createObjectURL(file))}" alt="">`:''}${h(file.name)}<button type="button" data-remove="${index}">×</button></div>`).join('');
}
function addFiles(files) { for (const file of files) if (file.size && state.files.length<8) state.files.push(file); renderDrafts(); }
function base64(file) { return new Promise((resolve,reject)=>{ const reader=new FileReader(); reader.onload=()=>resolve(String(reader.result).split(',')[1]); reader.onerror=reject; reader.readAsDataURL(file); }); }

async function init() {
  $('#display-name').value=localStorage.getItem('webspider_chat_name') || '';
  const result=await api('topics'); state.topics=result.topics; $('#invite-label').textContent=result.label;
  $('#available-agents').textContent=result.agents?.length?`Agents: ${result.agents.map((agent)=>agent.mention).join(', ')}`:'';
  $('#topics').innerHTML=state.topics.map((topic)=>`<button class="topic" data-id="${h(topic.id)}">${h(topic.name)}</button>`).join('') || '<div class="empty">No topics shared</div>';
  $('#composer').classList.toggle('hidden',!result.can_post);
  if (state.topics[0]) await selectTopic(state.topics[0].id);
  state.timer=setInterval(()=>poll(),2000);
}

$('#topics').addEventListener('click',(event)=>{ const button=event.target.closest('.topic'); if(button) selectTopic(button.dataset.id); });
$('#topics-toggle').addEventListener('click',()=>$('.chat-sidebar').classList.toggle('open'));
$('#display-name').addEventListener('change',saveName); $('#attach').addEventListener('click',()=>$('#file-input').click());
$('#file-input').addEventListener('change',(event)=>{addFiles(event.target.files);event.target.value='';});
$('#attachment-drafts').addEventListener('click',(event)=>{const button=event.target.closest('[data-remove]');if(button){state.files.splice(Number(button.dataset.remove),1);renderDrafts();}});
document.addEventListener('paste',(event)=>{ const itemFiles=[...(event.clipboardData?.items||[])].filter((item)=>item.kind==='file').map((item)=>item.getAsFile()).filter(Boolean);const files=itemFiles.length?itemFiles:[...(event.clipboardData?.files||[])];if(files.length){event.preventDefault();addFiles(files);$('#message').focus();} });
$('#message').addEventListener('input',(event)=>{event.target.style.height='auto';event.target.style.height=`${event.target.scrollHeight}px`;});
$('#message').addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.target.form.requestSubmit();}});
$('#composer').addEventListener('submit',async(event)=>{event.preventDefault();if(!name())return toast('Enter your name first.',true);const body=$('#message').value.trim();if(!body&&!state.files.length)return;const button=$('.send');button.disabled=true;try{saveName();const attachments=[];let total=0;for(const file of state.files){total+=file.size;if(total>20*1024*1024)throw new Error('Attachments are limited to 20 MiB per message.');attachments.push({filename:file.name,mime_type:file.type||'application/octet-stream',data_base64:await base64(file)});}await api(`topics/${encodeURIComponent(state.topic.id)}/messages`,{method:'POST',body:{display_name:name(),body,attachments}});$('#message').value='';state.files=[];renderDrafts();await poll(true);}catch(error){toast(error.message,true);}finally{button.disabled=false;}});
init().catch((error)=>{ $('#messages').innerHTML=`<div class="empty">${h(error.message)}</div>`; });
