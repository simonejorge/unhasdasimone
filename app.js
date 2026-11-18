/* Unhas da Simone | Agendamento + Supabase */
(() => {
  'use strict';
  const URL_BASE = 'https://iszptjpzqicpmzkmogai.supabase.co';
  const PUBLIC_KEY = 'sb_publishable_-m2Hd6qEp76A2LMQwnJrPw_yAH44AVM';
  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const brl = cents => (cents/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const todayBR = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const normalizePhone = value => {let d=String(value||'').replace(/\D/g,'');if((d.length===12||d.length===13)&&d.startsWith('55'))d=d.slice(2);return d;};
  const addDays = (iso, days) => {const d=new Date(iso+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)};
  const weekday = iso => new Date(iso+'T12:00:00Z').toLocaleDateString('pt-BR',{weekday:'short',timeZone:'UTC'}).replace('.','').toUpperCase();
  const formattedDate = iso => new Date(iso+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC',day:'2-digit',month:'long',year:'numeric'});
  async function rpc(name, body={}){
    const response=await fetch(`${URL_BASE}/rest/v1/rpc/${name}`,{
      method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json','apikey':PUBLIC_KEY},
      body:JSON.stringify(body), cache:'no-store'
    });
    let payload;
    try {payload=await response.json();}catch{payload=null;}
    if(!response.ok)throw Error(payload?.message || payload?.hint || `Erro de conexão (${response.status}).`);
    return payload;
  }
  async function googleBusyForDate(date){
    const timeMin=new Date(`${date}T00:00:00-03:00`).toISOString();
    const timeMax=new Date(`${addDays(date,1)}T00:00:00-03:00`).toISOString();
    const response=await fetch(`${URL_BASE}/functions/v1/unhas-da-simone-google-calendar`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':PUBLIC_KEY},
      body:JSON.stringify({action:'public_freebusy',timeMin,timeMax}),
      cache:'no-store'
    });
    const raw=await response.text();
    let payload={};
    if(raw){
      try{payload=JSON.parse(raw);}
      catch{throw new Error(`Não foi possível consultar a agenda Google (HTTP ${response.status}).`);}
    }
    if(!response.ok)throw new Error(payload?.error||`Não foi possível consultar a agenda Google (HTTP ${response.status}).`);
    if(!Array.isArray(payload.busy))throw new Error('A agenda Google não retornou os horários ocupados.');
    return payload.busy;
  }
  function overlapsGoogleBusy(date,time,duration,busy){
    const start=new Date(`${date}T${time}:00-03:00`).getTime();
    const end=start+Number(duration||30)*60000;
    return (busy||[]).some(period=>{
      const busyStart=Date.parse(period.start),busyEnd=Date.parse(period.end);
      return Number.isFinite(busyStart)&&Number.isFinite(busyEnd)&&start<busyEnd&&end>busyStart;
    });
  }
  let data=null,step=1,dateOffset=0,fetching=0;
  const booking={service_id:null, professional_id:null, date:null, time:null, coupon:null, vip:null};
  const state=()=>({service:data.services.find(x=>x.id===booking.service_id),pro:data.professionals.find(x=>x.id===booking.professional_id)});
  $('#currentYear').textContent=new Date().getFullYear();
  async function init(){
    $('#serviceOptions').innerHTML='<p class="empty-note">Carregando serviços...</p>';
    try{
      data=await rpc('alcapone_catalogo');
      if(!data?.services?.length||!data?.professionals?.length)throw Error('O catálogo ainda não está configurado.');
      booking.date=data.today || todayBR();
      $('#demoBanner').hidden=true;
      renderServices();renderPros();renderDates();go(1);
    }catch(e){
      $('#demoBanner').hidden=false;
      $('#serviceOptions').innerHTML=`<p class="empty-note">Não foi possível carregar os serviços. ${esc(e.message)}</p><button type="button" class="action-secondary" id="retryInit">TENTAR NOVAMENTE ↻</button>`;
      $('#retryInit').addEventListener('click',init);
    }
  }
  function renderServices(){
    $('#serviceOptions').innerHTML=data.services.map(s=>{
      return `<button type="button" class="choice" data-id="${esc(s.id)}" aria-pressed="false">
        <div><strong>${esc(s.name)}</strong></div>
        <span class="choice-foot"><small>${s.duration} MIN</small><b>${s.from_price?'A partir de ':''}${brl(s.price_cents)}</b></span></button>`;
    }).join('');
    $$('.choice').forEach(btn=>btn.addEventListener('click',()=>{
      booking.service_id=btn.dataset.id; booking.time=null; booking.coupon=null;
      $('#clientCouponCode').value='';setCouponMessage('');
      $$('.choice').forEach(el=>{el.classList.toggle('selected',el===btn);el.setAttribute('aria-pressed',String(el===btn))});updateNext();
    }));
  }
  function renderPros(){
    $('#proOptions').innerHTML=data.professionals.map(p=>`<button type="button" class="pro-choice" data-id="${esc(p.id)}" aria-pressed="false"><img src="${esc(p.photo)}" alt="${esc(p.name)}, profissional do Unhas da Simone"><span><small>MANICURE · UNHAS DA SIMONE</small><strong>${esc(p.name)}</strong></span></button>`).join('');
    $$('.pro-choice').forEach(btn=>btn.addEventListener('click',()=>{
      booking.professional_id=btn.dataset.id;booking.time=null;
      $$('.pro-choice').forEach(el=>{el.classList.toggle('selected',el===btn);el.setAttribute('aria-pressed',String(el===btn))});updateNext();
    }));
  }
  function go(n){
    step=n;
    $$('.wizard-panel').forEach(el=>el.classList.toggle('active',Number(el.dataset.panel)===n));
    $$('.steps li').forEach(el=>{const s=Number(el.dataset.step);el.classList.toggle('active',s===Math.min(n,4));el.classList.toggle('done',s<Math.min(n,4))});
    $('#wizardFooter').hidden=n===5;
    $('#backBtn').hidden=n<=1;
    if(n===3){renderDates();if(booking.date)loadAvailability();else $('#slotArea').innerHTML='<p class="empty-note">Selecione uma data para consultar os horários.</p>';}
    if(n===4)renderSummary();
    updateNext();
    if(n===5)$('#formulario').scrollIntoView({block:'start',behavior:'smooth'});
  }
  function updateNext(){
    const btn=$('#nextBtn');btn.textContent=step===4?'CONFIRMAR RESERVA':'CONTINUAR';
    if(step!==4)btn.insertAdjacentHTML('beforeend',' <span>↗</span>');
    btn.disabled=(step===1&&!booking.service_id)||(step===2&&!booking.professional_id)||(step===3&&!booking.time);
    $('#stepHint').textContent=({1:'Escolha um serviço.',2:'Selecione o profissional.',3:'Selecione uma data e um horário.',4:'Seus dados serão usados somente para esta reserva.'})[step]||'';
  }
  $('#nextBtn').addEventListener('click',()=>{if(step===4){submit();return;}if(!$('#nextBtn').disabled)go(step+1)});
  $('#backBtn').addEventListener('click',()=>go(Math.max(1,step-1)));
  $('#newBooking').addEventListener('click',()=>{booking.service_id=null;booking.professional_id=null;booking.time=null;booking.coupon=null;$('#clientCouponCode').value='';setCouponMessage('');renderServices();renderPros();go(1)});
  function renderDates(){
    if(!data)return;
    const current=addDays(data.today,dateOffset),last=addDays(data.today,data.max_days);
    $('#monthTitle').textContent=new Date(current+'T12:00:00Z').toLocaleDateString('pt-BR',{month:'long',year:'numeric',timeZone:'UTC'}).toUpperCase();
    $('#datePrev').disabled=dateOffset===0;
    $('#dateNext').disabled=dateOffset+7>data.max_days;
    let html='';
    for(let i=0;i<7;i++){
      const iso=addDays(current,i),wd=new Date(iso+'T12:00:00Z').getUTCDay();
      const closed=(wd===0||wd===1)&&!booking.vip,out=iso>last;
      html+=`<button type="button" class="day-pill ${booking.date===iso?'selected':''}" data-date="${iso}" ${closed||out?'disabled':''} aria-pressed="${booking.date===iso}"><small>${weekday(iso)}</small><strong>${iso.slice(8)}</strong></button>`;
    }
    $('#daysStrip').innerHTML=html;
    $$('.day-pill:not(:disabled)').forEach(el=>el.addEventListener('click',()=>{booking.date=el.dataset.date;booking.time=null;renderDates();loadAvailability();updateNext()}));
  }
  $('#dateNext').addEventListener('click',()=>{dateOffset=Math.min(dateOffset+7,56);booking.date=null;booking.time=null;renderDates();$('#slotArea').innerHTML='<p class="empty-note">Selecione uma data para consultar os horários.</p>';updateNext()});
  $('#datePrev').addEventListener('click',()=>{dateOffset=Math.max(0,dateOffset-7);booking.date=null;booking.time=null;renderDates();$('#slotArea').innerHTML='<p class="empty-note">Selecione uma data para consultar os horários.</p>';updateNext()});
  async function loadAvailability(silent=false){
    const seq=++fetching;if(!booking.date)return;
    if(!silent)$('#slotArea').innerHTML='<p class="empty-note">Consultando horários...</p>';
    $('#availabilityMeta').textContent=formattedDate(booking.date);
    try{
      const [result,googleBusy]=await Promise.all([
        rpc('alcapone_disponibilidade',{p_profissional_id:booking.professional_id,p_servico_id:booking.service_id,p_data:booking.date,p_codigo_vip:booking.vip?.code||null,p_whatsapp:booking.vip?.phone||null}),
        googleBusyForDate(booking.date)
      ]);
      if(seq!==fetching)return;
      const duration=Number(state().service?.duration||30);
      const slots=(result||[])
        .filter(item=>!overlapsGoogleBusy(booking.date,item.hora,duration,googleBusy))
        .map(item=>({time:item.hora,vipOnly:Boolean(item.vip_exclusivo)}));
      const slotArea=$('#slotArea');
      const signature=JSON.stringify(slots.map(s=>[s.time,s.vipOnly]));
      if(booking.time&&!slots.some(s=>s.time===booking.time)){
        booking.time=null;
        updateNext();
      }
      // Na atualização silenciosa, só redesenha quando os horários realmente mudam.
      if(silent&&slotArea.dataset.slotsSignature===signature)return;
      slotArea.dataset.slotsSignature=signature;
      if(!slots.length){slotArea.innerHTML='<p class="empty-note">Sem horários disponíveis. Experimente outra data.</p>';booking.time=null;updateNext();return;}
      let html='';
      for(const [title,items] of [['MANHÃ',slots.filter(s=>s.time<'12:00')],['TARDE',slots.filter(s=>s.time>='12:00')]]){
        if(!items.length)continue;
        html+=`<div class="period-label">${title}</div><div class="time-buttons">${items.map(s=>`<button type="button" class="time-slot ${booking.time===s.time?'selected':''}" data-time="${esc(s.time)}" aria-pressed="${booking.time===s.time}">${esc(s.time)}${s.vipOnly?'<small class="vip-slot-tag">VIP</small>':''}</button>`).join('')}</div>`;
      }
      slotArea.innerHTML=html;
      $$('.time-slot').forEach(el=>el.addEventListener('click',()=>{booking.time=el.dataset.time;$$('.time-slot').forEach(e=>{e.classList.toggle('selected',e===el);e.setAttribute('aria-pressed',String(e===el))});updateNext()}));
    }catch(e){
      // Uma falha transitória durante o polling não apaga os horários já exibidos.
      if(!silent&&seq===fetching)$('#slotArea').innerHTML=`<p class="empty-note">${esc(e.message)}. Tente outra data ou recarregue a página.</p>`;
    }
  }

  // Mantém a disponibilidade atualizada enquanto a etapa de escolha de horário
  // estiver aberta. Também consulta novamente quando a pessoa retorna à aba.
  let autoRefreshInFlight=false,lastAutoRefreshAt=0;
  async function autoRefreshAvailability(){
    if(document.visibilityState!=='visible'||step!==3||!booking.date||!booking.professional_id||!booking.service_id)return;
    if(autoRefreshInFlight||Date.now()-lastAutoRefreshAt<5000)return;
    autoRefreshInFlight=true;
    lastAutoRefreshAt=Date.now();
    try{await loadAvailability(true);}finally{autoRefreshInFlight=false;}
  }
  window.setInterval(autoRefreshAvailability,30000);
  window.addEventListener('focus',autoRefreshAvailability);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible')autoRefreshAvailability();
  });
  function setVipMessage(text,type=''){
    const el=$('#vipMessage');if(!el)return;el.textContent=text||'';el.classList.toggle('success',type==='success');el.classList.toggle('error',type==='error');
  }
  function vipDiscountFor(service){
    if(!booking.vip||!service)return 0;
    let best=0;const profile=booking.vip;
    if(profile.discount_type==='percentual')best=service.price_cents/100*Number(profile.discount_value||0)/100;
    else if(profile.discount_type==='fixo')best=Math.min(service.price_cents/100,Number(profile.discount_value||0));
    (profile.offers||[]).forEach(o=>{
      if(o.type==='combo')return;
      if(o.service_id&&o.service_id!==service.id)return;
      const today=data?.today||todayBR();if(today<o.start_date||today>o.end_date)return;
      let amount=0;if(o.discount_type==='percentual')amount=service.price_cents/100*Number(o.discount_value||0)/100;
      else if(o.discount_type==='fixo')amount=Math.min(service.price_cents/100,Number(o.discount_value||0));
      best=Math.max(best,amount);
    });
    return Math.min(service.price_cents/100,best);
  }
  function renderVipDashboard(){
    const el=$('#vipDashboard');if(!booking.vip){el.hidden=true;el.innerHTML='';$('#vipToggle').classList.remove('is-active');$('#vipToggleTitle').textContent='CLIENTE VIP? ACESSE AQUI';$('#vipToggleText').textContent='HORÁRIOS EXCLUSIVOS · BENEFÍCIOS · PONTOS';return;}
    const v=booking.vip,discountType=v.discount_type==='percentual'?`${Number(v.discount_value).toLocaleString('pt-BR')}%`:v.discount_type==='fixo'?brl(Math.round(Number(v.discount_value)*100)):'Benefícios ativos';
    const offers=(v.offers||[]).map(o=>`<div class="vip-offer"><strong>${esc(o.title)} · ${o.type==='combo'?'COMBO':'PROMOÇÃO'}</strong><p>${esc(o.description)}</p>${o.type==='promocao'&&o.discount_type!=='nenhum'?`<small>Benefício: ${o.discount_type==='percentual'?`${Number(o.discount_value).toLocaleString('pt-BR')}%`:brl(Math.round(Number(o.discount_value)*100))}</small>`:''}</div>`).join('');
    const rewards=(v.rewards||[]).map(r=>`<div class="vip-reward"><div><strong>${esc(r.name)} · ${Number(r.points)} PONTOS</strong><p>${esc(r.description||'')}</p></div><button type="button" data-vip-reward="${esc(r.id)}" ${r.can_redeem?'':'disabled'}>${r.can_redeem?'SOLICITAR':'PONTOS INSUFICIENTES'}</button></div>`).join('');
    el.innerHTML=`<div class="vip-dashboard-head"><strong>OLÁ, ${esc(v.client_name)}.</strong><span>ACESSO VIP ATIVO${v.vip_level?` · ${esc(v.vip_level).toUpperCase()}`:''}</span><button type="button" class="vip-logout" data-vip-logout>SAIR DA ÁREA VIP</button></div><div class="vip-metrics"><div class="vip-metric"><strong>${Number(v.points_available||0)}</strong><small>PONTOS DISPONÍVEIS</small></div><div class="vip-metric"><strong>${esc(discountType)}</strong><small>DESCONTO VIP</small></div><div class="vip-metric"><strong>${(v.offers||[]).length}</strong><small>OFERTAS ATIVAS</small></div></div><p>Seu nível atual: <strong>${esc(v.vip_level||'VIP')}</strong>. Seu código libera horários especiais e benefícios durante o agendamento. Os pontos são creditados após o atendimento ser concluído.</p>${offers?`<strong class="micro">PROMOÇÕES E COMBOS</strong><div class="vip-offer-list">${offers}</div>`:''}${rewards?`<strong class="micro" style="display:block;margin-top:14px">TROQUE SEUS PONTOS</strong><div class="vip-reward-list">${rewards}</div>`:''}`;
    $('#vipToggle').classList.add('is-active');$('#vipToggleTitle').textContent='ÁREA VIP ATIVA · VER BENEFÍCIOS';$('#vipToggleText').textContent=`${v.vip_level||'CLIENTE VIP'} · ${Number(v.points_available||0)} PONTOS DISPONÍVEIS`;
    el.hidden=false;
    $('[data-vip-logout]',el).addEventListener('click',()=>clearVip('Acesso VIP encerrado.'));
    $$('[data-vip-reward]',el).forEach(btn=>btn.addEventListener('click',async()=>{
      if(!booking.vip)return;btn.disabled=true;btn.textContent='ENVIANDO...';
      try{const result=await rpc('alcapone_vip_solicitar_resgate',{p_codigo:booking.vip.code,p_whatsapp:booking.vip.phone,p_recompensa_id:btn.dataset.vipReward});await validateVip(true);setVipMessage(result?.message||'Solicitação enviada.','success');}
      catch(e){setVipMessage(e.message,'error');btn.disabled=false;btn.textContent='SOLICITAR';}
    }));
  }
  async function validateVip(silent=false){
    const code=$('#vipCode').value.trim().toUpperCase(),phone=$('#vipPhone').value.trim();
    if(!code||phone.replace(/\D/g,'').length<10){setVipMessage('Informe o código VIP e o WhatsApp cadastrado.','error');return;}
    const button=$('#validateVip');button.disabled=true;button.textContent='VALIDANDO...';
    if(!silent)setVipMessage('Validando seu acesso...');
    try{
      const result=await rpc('alcapone_validar_vip',{p_codigo:code,p_whatsapp:phone});
      if(!result?.valid)throw new Error(result?.message||'Não foi possível validar o acesso VIP.');
      const phoneDigits=normalizePhone(phone);
      booking.vip={...result,code:result.code||code,phone:phoneDigits};
      if(booking.coupon){booking.coupon=null;$('#clientCouponCode').value='';setCouponMessage('Benefício VIP ativo. Cupons não são acumulados com descontos VIP.');}
      $('#clientPhone').value=phone;
      if(result.client_name)$('#clientName').value=result.client_name;
      setVipMessage(result.message||'Acesso VIP liberado.','success');renderVipDashboard();
      if(step===3){renderDates();loadAvailability();}if(step===4)renderSummary();
    }catch(e){const hadVip=Boolean(booking.vip);booking.vip=null;renderVipDashboard();setVipMessage(e.message,'error');if(hadVip&&step===3){booking.time=null;if(booking.date&&[0,1].includes(new Date(booking.date+'T12:00:00Z').getUTCDay()))booking.date=null;renderDates();if(booking.date)loadAvailability();else $('#slotArea').innerHTML='<p class="empty-note">Selecione uma data para consultar os horários.</p>';updateNext();}if(hadVip&&step===4){booking.time=null;if(booking.date&&[0,1].includes(new Date(booking.date+'T12:00:00Z').getUTCDay()))booking.date=null;go(3);}}
    finally{button.disabled=false;button.textContent='ACESSAR VIP ↗';}
  }
  function clearVip(message=''){
    if(!booking.vip)return;booking.vip=null;renderVipDashboard();setVipMessage(message,'');
    $('#vipToggle').classList.remove('is-active');$('#vipToggleTitle').textContent='CLIENTE VIP? ACESSE AQUI';$('#vipToggleText').textContent='HORÁRIOS EXCLUSIVOS · BENEFÍCIOS · PONTOS';
    if(step===3){booking.time=null;if(booking.date&&[0,1].includes(new Date(booking.date+'T12:00:00Z').getUTCDay()))booking.date=null;renderDates();if(booking.date)loadAvailability();else $('#slotArea').innerHTML='<p class="empty-note">Selecione uma data para consultar os horários.</p>';updateNext();}
    if(step===4){booking.time=null;if(booking.date&&[0,1].includes(new Date(booking.date+'T12:00:00Z').getUTCDay()))booking.date=null;go(3);}
  }
  $('#vipToggle').addEventListener('click',()=>{
    const dialog=$('#vipDialog');
    if(!dialog.open)dialog.showModal();
    if(!booking.vip)setTimeout(()=>$('#vipPhone').focus(),80);
  });
  $('#closeVipDialog').addEventListener('click',()=>$('#vipDialog').close());
  $('#vipDialog').addEventListener('click',event=>{if(event.target===$('#vipDialog'))$('#vipDialog').close();});
  $('#vipCode').addEventListener('input',()=>{const v=$('#vipCode').value.toUpperCase().replace(/[^A-Z0-9_-]/g,'');$('#vipCode').value=v;if(booking.vip&&v!==booking.vip.code)clearVip('Código alterado. Valide novamente.');});
  $('#vipPhone').addEventListener('input',()=>{if(booking.vip&&normalizePhone($('#vipPhone').value)!==booking.vip.phone)clearVip('WhatsApp alterado. Valide novamente.');});
  $('#validateVip').addEventListener('click',()=>validateVip());
  $('#clientPhone').addEventListener('input',()=>{if(booking.vip&&normalizePhone($('#clientPhone').value)!==booking.vip.phone)clearVip('WhatsApp alterado. O acesso VIP foi removido.');});

  function setCouponMessage(text,type=''){
    const el=$('#couponMessage');if(!el)return;
    el.textContent=text||'';el.classList.toggle('success',type==='success');el.classList.toggle('error',type==='error');
  }
  function clearAppliedCoupon(message=''){
    if(!booking.coupon)return;
    booking.coupon=null;setCouponMessage(message,'');
    if(step===4)renderSummary();
  }
  $('#applyCoupon').addEventListener('click',async()=>{
    const code=$('#clientCouponCode').value.trim().toUpperCase();
    const phone=$('#clientPhone').value.trim();
    if(booking.vip){setCouponMessage('O benefício VIP não é acumulado com cupons. Remova o acesso VIP para usar este cupom.','error');return;}
    const phoneDigits=phone.replace(/\D/g,'');
    const serviceId=booking.service_id;
    if(!code){setCouponMessage('Digite o código do cupom.','error');return;}
    if(phoneDigits.length<10){setCouponMessage('Informe primeiro seu WhatsApp com DDD.','error');$('#clientPhone').focus();return;}
    const button=$('#applyCoupon');button.disabled=true;button.textContent='VALIDANDO...';$('#nextBtn').disabled=true;setCouponMessage('Consultando campanha...');
    try{
      const result=await rpc('alcapone_validar_cupom',{p_codigo:code,p_servico_id:serviceId,p_whatsapp:phone});
      if(!result?.valid)throw new Error(result?.message||'Não foi possível aplicar este cupom.');
      if($('#clientCouponCode').value.trim().toUpperCase()!==code||$('#clientPhone').value.replace(/\D/g,'')!==phoneDigits||booking.service_id!==serviceId)throw new Error('Os dados foram alterados durante a validação. Aplique o cupom novamente.');
      booking.coupon={...result,code:result.code||code,service_id:serviceId,phone:phoneDigits};
      setCouponMessage(`Cupom ${booking.coupon.code} aplicado. Desconto de ${brl(Math.round(Number(result.discount_amount)*100))}.`,'success');
      renderSummary();
    }catch(e){booking.coupon=null;setCouponMessage(e.message,'error');renderSummary();}
    finally{button.disabled=false;button.textContent='APLICAR';updateNext();}
  });
  $('#clientCouponCode').addEventListener('input',()=>{
    if(booking.coupon&&$('#clientCouponCode').value.trim().toUpperCase()!==booking.coupon.code)clearAppliedCoupon('Código alterado. Aplique novamente para validar.');
  });
  $('#clientPhone').addEventListener('input',()=>{
    if(booking.coupon&&$('#clientPhone').value.replace(/\D/g,'')!==booking.coupon.phone)clearAppliedCoupon('WhatsApp alterado. Aplique o cupom novamente.');
  });
  function renderSummary(){
    const {service,pro}=state();
    const vipDiscount=booking.vip?vipDiscountFor(service):0;
    const couponDiscount=booking.coupon?Number(booking.coupon.discount_amount):0;
    const discountCents=Math.round((booking.vip?vipDiscount:couponDiscount)*100);
    const totalCents=Math.max(0,service.price_cents-discountCents);
    const benefitRows=discountCents>0?`<div class="summary-row"><span>VALOR ORIGINAL</span><strong>${brl(service.price_cents)}</strong></div><div class="summary-row"><span>${booking.vip?'BENEFÍCIO VIP':`CUPOM ${esc(booking.coupon.code)}`}</span><strong>− ${brl(discountCents)}</strong></div>`:'';
    const totalLabel=discountCents>0?'VALOR FINAL':`VALOR ${service.from_price?'INICIAL':'DO SERVIÇO'}`;
    const vipTag=booking.vip?`<div class="summary-row"><span>ACESSO</span><strong>CLIENTE VIP · ${esc(booking.vip.code)}</strong></div>`:'';
    $('#summary').innerHTML=`<div class="summary-row"><span>SERVIÇO</span><strong>${esc(service.name)}</strong></div><div class="summary-row"><span>PROFISSIONAL</span><strong>${esc(pro.name)}</strong></div><div class="summary-row"><span>DATA E HORA</span><strong>${esc(formattedDate(booking.date))} · ${esc(booking.time)}</strong></div><div class="summary-row"><span>DURAÇÃO</span><strong>${service.duration} minutos</strong></div>${vipTag}${benefitRows}<div class="summary-row summary-total"><span>${totalLabel}</span><strong>${brl(totalCents)}</strong></div>`;
    $('#formError').hidden=true;
  }
  function calendarDateParts(date, time, duration){
    const start = new Date(`${date}T${time}:00-03:00`);
    const end = new Date(start.getTime() + Number(duration || 30) * 60000);
    const googleStamp = d => new Intl.DateTimeFormat('sv-SE',{
      timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
    }).format(d).replace(/[-:]/g,'').replace(' ','T');
    const utcStamp = d => d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    return {start,end,googleStart:googleStamp(start),googleEnd:googleStamp(end),utcStart:utcStamp(start),utcEnd:utcStamp(end)};
  }
  function icsEscape(value){
    return String(value ?? '').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
  }
  function prepareConfirmationActions({payload,service,professional,clientName,phone}){
    const {start,end,googleStart,googleEnd,utcStart,utcEnd}=calendarDateParts(booking.date,booking.time,service.duration);
    const title=`Unhas da Simone — ${service.name}`;
    const location='Unhas da Simone';
    const code=payload.code || '';
    const details=`Reserva ${code}\nCliente: ${clientName}\nServiço: ${service.name}\nProfissional: ${professional.name}\nDuração: ${service.duration} minutos\nCódigo: ${code}\nConsulte ou cancele: ${new URL(`minha.html?token=${encodeURIComponent(payload.token)}`,locationHref()).href}`;
    const googleUrl='https://calendar.google.com/calendar/render?action=TEMPLATE'
      +`&text=${encodeURIComponent(title)}`
      +`&dates=${googleStart}/${googleEnd}`
      +`&ctz=${encodeURIComponent('America/Sao_Paulo')}`
      +`&details=${encodeURIComponent(details)}`
      +`&location=${encodeURIComponent(location)}`;
    $('#googleCalendarLink').href=googleUrl;

    const icsLines=[
      'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Unhas da Simone//Agendamento//PT-BR',
      'CALSCALE:GREGORIAN','METHOD:PUBLISH','BEGIN:VEVENT',
      `UID:${icsEscape(payload.token || code+'@unhasdasimone')}`,
      `DTSTAMP:${icsStamp(new Date())}`,
      `DTSTART:${utcStart}`,`DTEND:${utcEnd}`,
      `SUMMARY:${icsEscape(title)}`,
      `DESCRIPTION:${icsEscape(details)}`,
      `LOCATION:${icsEscape(location)}`,
      'BEGIN:VALARM','TRIGGER:-PT1H','ACTION:DISPLAY','DESCRIPTION:Lembrete: seu horário na Unhas da Simone é em 1 hora.','END:VALARM',
      'BEGIN:VALARM','TRIGGER:-PT30M','ACTION:DISPLAY','DESCRIPTION:Lembrete: seu horário na Unhas da Simone é em 30 minutos.','END:VALARM',
      'END:VEVENT','END:VCALENDAR'
    ];
    $('#downloadCalendar').onclick=()=>{
      const blob=new Blob([icsLines.join('\r\n')+'\r\n'],{type:'text/calendar;charset=utf-8'});
      const url=URL.createObjectURL(blob);const a=document.createElement('a');
      a.href=url;a.download=`unhas-da-simone-reserva-${String(code||'horario').replace(/[^a-z0-9_-]/gi,'')}.ics`;
      document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
    };
    let digits=String(phone||'').replace(/\D/g,'');
    if(digits.startsWith('55')) digits=digits.slice(2);
    digits=digits.replace(/^0/,'');
    const whatsappNumber=`55${digits}`;
    const dateLabel=formattedDate(booking.date);
    const finalPriceCents=Math.round(Number(payload.final_price ?? service.price_cents/100)*100);
    const discountCents=Math.round(Number(payload.discount_amount||0)*100);
    const valueLabel=`${service.from_price?'A partir de ':''}${brl(finalPriceCents)}`;
    const couponLine=payload.coupon_code?`\nCupom: ${payload.coupon_code}\nDesconto: ${brl(discountCents)}`:payload.discount_source==='vip'?`\nBenefício: Cliente VIP\nDesconto: ${brl(discountCents)}`:'';
    const vipLine=payload.vip_code?'\nCliente VIP: pontos serão creditados após o atendimento concluído.':'';
    const manageUrl=new URL(`minha.html?token=${encodeURIComponent(payload.token)}`,locationHref()).href;
    const message=`AGENDAMENTO CONFIRMADO — UNHAS DA SIMONE\n\nHora: ${booking.time}\nData: ${dateLabel}\nProfissional: ${professional.name}\nServiço: ${service.name}\nValor: ${valueLabel}${couponLine}${vipLine}\n\nCódigo da reserva: ${code}\nConsultar ou cancelar: ${manageUrl}`;
    $('#whatsappSummary').href=`https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
    $('#whatsappSummary').setAttribute('aria-label','Abrir uma conversa com seu próprio número no WhatsApp, com o resumo do agendamento preenchido. Você só precisa tocar em Enviar.');
  }
  function icsStamp(date){return date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');}
  function locationHref(){return window.location.href;}

  async function submit(){
    const err=$('#formError');
    const fullName=$('#clientName').value.trim(),phone=$('#clientPhone').value.trim(),email=$('#clientEmail').value.trim();
    if(fullName.length<3||phone.replace(/\D/g,'').length<10||!$('#consent').checked){
      err.textContent='Preencha nome e WhatsApp com DDD e aceite o uso dos dados.';err.hidden=false;return;
    }
    const next=$('#nextBtn');next.disabled=true;next.textContent='CONFIRMANDO...';err.hidden=true;
    try{
      // Revalida no último instante: o compromisso pode ter sido criado no Google
      // depois que a pessoa abriu a lista de horários.
      const googleBusy=await googleBusyForDate(booking.date);
      const service=state().service;
      if(overlapsGoogleBusy(booking.date,booking.time,service.duration,googleBusy)){
        booking.time=null;
        go(3);
        $('#slotArea').innerHTML='<p class="empty-note">Esse horário acabou de ficar indisponível na agenda da Simone. Escolha outro horário.</p>';
        return;
      }
      const payload=await rpc('alcapone_agendar',{
        p_profissional_id:booking.professional_id,p_servico_id:booking.service_id,
        p_data:booking.date,p_hora:booking.time,p_nome:fullName,p_whatsapp:phone,
        p_email:email||null,p_observacoes:$('#clientNotes').value.trim()||null,
        p_cupom:booking.coupon?.code||null,p_codigo_vip:booking.vip?.code||null
      });
      const finalPriceCents=Math.round(Number(payload.final_price ?? state().service.price_cents/100)*100);
      const discountCents=Math.round(Number(payload.discount_amount||0)*100);
      const benefitInfo=discountCents>0?`<div class="summary-row"><span>BENEFÍCIO</span><strong>${payload.coupon_code?`CUPOM ${esc(payload.coupon_code)}`:payload.discount_source==='vip'?'CLIENTE VIP':'DESCONTO'}</strong></div><div class="summary-row"><span>DESCONTO</span><strong>− ${brl(discountCents)}</strong></div>`:'';
      const vipInfo=payload.vip_code?`<div class="summary-row"><span>FIDELIDADE</span><strong>CLIENTE VIP · PONTOS APÓS O ATENDIMENTO</strong></div>`:'';
      $('#confirmationInfo').innerHTML=`<div class="summary-row"><span>CÓDIGO</span><strong>${esc(payload.code)}</strong></div><div class="summary-row"><span>SERVIÇO</span><strong>${esc(payload.service)}</strong></div><div class="summary-row"><span>PROFISSIONAL</span><strong>${esc(payload.professional)}</strong></div><div class="summary-row"><span>DATA/HORA</span><strong>${esc(formattedDate(booking.date))} · ${esc(booking.time)}</strong></div>${vipInfo}${benefitInfo}<div class="summary-row summary-total"><span>VALOR FINAL</span><strong>${brl(finalPriceCents)}</strong></div>`;
      $('#manageLink').href='minha.html?token='+encodeURIComponent(payload.token);
      prepareConfirmationActions({payload,service:state().service,professional:state().pro,clientName:fullName,phone});
      go(5);
    }catch(e){err.textContent=e.message;err.hidden=false;updateNext();}
  }
  init();
})();
