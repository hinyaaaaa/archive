'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
var CFG = {
  APP_NAME:'TaskNOVA', APP_VERSION:'6.1',
  STORAGE_KEY:'altair_data',
  LEGACY_KEYS:['altair_v2','altair_v1'],
  WEEKDAY_NAMES:['日','月','火','水','木','金','土'],
  DEFAULT_DAILY_CAPACITY:10,
};

// ─── COLOR / LABEL ───────────────────────────────────────────────────────────
function loadColor(v){
  var t=Math.max(0,Math.min(1,(v-0.5)/4.5));
  if(t<0.25){var r=Math.round(58+(224-58)*(t/0.25)),g=Math.round(170+(144-170)*(t/0.25)),b=Math.round(114+(48-114)*(t/0.25));return'rgb('+r+','+g+','+b+')';}
  else if(t<0.5){var tt=(t-0.25)/0.25,r=Math.round(224+(226-224)*tt),g=Math.round(144+(75-144)*tt),b=Math.round(48+(74-48)*tt);return'rgb('+r+','+g+','+b+')';}
  else{var tt=(t-0.5)/0.5,r=Math.round(226+(168-226)*tt),g=Math.round(75+(85-75)*tt),b=Math.round(74+(247-74)*tt);return'rgb('+r+','+g+','+b+')';}
}
function loadLabel(v){return String(v%1===0?v:v.toFixed(1));}
function normalizeText(v){return String(v||'').trim().normalize('NFKC').toLowerCase();}

// ─── STATE ───────────────────────────────────────────────────────────────────
var S={};
var STATE_DEFAULTS={tasks:[],todayPlan:null,extraDoneToday:null,learningHistory:{},
  learningAnalytics:{bySubject:{},byWeekday:{},compressed:{}},adaptiveHistory:{recommendedCapacity:null,missStreak:0,hitStreak:0,lastCapacityUpdateDate:null,dailyCompletion:{}},sessionHistory:[],
  settings:{capacityWeekday:10,capacityHoliday:6,holidays:[],bg:'',bgOpacity:65,todayOverride:null}};

function loadState(){
  try{
    var raw=localStorage.getItem(CFG.STORAGE_KEY);
    if(!raw){for(var ki=0;ki<CFG.LEGACY_KEYS.length;ki++){var leg=localStorage.getItem(CFG.LEGACY_KEYS[ki]);if(leg){raw=leg;try{localStorage.setItem(CFG.STORAGE_KEY,leg);localStorage.removeItem(CFG.LEGACY_KEYS[ki]);}catch(e){}break;}}}
    S=raw?Object.assign({},STATE_DEFAULTS,JSON.parse(raw)):Object.assign({},STATE_DEFAULTS);
  }catch(e){S=Object.assign({},STATE_DEFAULTS);}
  if(!Array.isArray(S.tasks))S.tasks=[];
  if(!S.learningHistory||typeof S.learningHistory!=='object'||Array.isArray(S.learningHistory))S.learningHistory={};
  else S.learningHistory=Object.assign({},S.learningHistory);
  _ensureAdaptiveDefaults();
  var sv=S.settings||{};
  S.settings=Object.assign({capacityWeekday:sv.dailyCapacity||CFG.DEFAULT_DAILY_CAPACITY,capacityHoliday:6,holidays:[],bg:'',bgOpacity:65,todayOverride:null},sv);
  delete S.settings.dailyCapacity;
  if(S.todayPlan&&!Array.isArray(S.todayPlan.entries))S.todayPlan=null;
  var td=today();
  if(!S.extraDoneToday||S.extraDoneToday.date!==td)S.extraDoneToday={date:td,taskIds:[],load:0};
  _purgeDoneTasks();
  updateRecommendedCapacityForNewDay(getTodayCapacity());
}
function saveState(){try{localStorage.setItem(CFG.STORAGE_KEY,JSON.stringify(S));}catch(e){showToast('保存失敗（容量不足の可能性があります）');}}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function generateId(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6);}
function today(){var d=new Date();return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());}
function pad2(n){return String(n).padStart(2,'0');}
function localDateStr(d){return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());}
function sanitize(str){return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function dateAddDays(ds,n){var d=new Date(ds+'T00:00:00');d.setDate(d.getDate()+n);return localDateStr(d);}
function dayOfWeek(ds){return new Date(ds+'T00:00:00').getDay();}
function daysUntil(ds,baseDate){var n=baseDate?new Date(baseDate+'T00:00:00'):new Date();n.setHours(0,0,0,0);var dl=new Date(ds+'T00:00:00');return Math.round((dl-n)/86400000);}

function isHoliday(ds){
  if(S.settings&&S.settings.todayOverride&&S.settings.todayOverride.date===ds)return S.settings.todayOverride.isHoliday;
  var dow=dayOfWeek(ds);if(dow===0||dow===6)return true;
  return((S.settings&&S.settings.holidays)||[]).includes(ds);
}
function setTodayOverride(isHol){S.settings.todayOverride={date:today(),isHoliday:isHol};saveState();rebalanceWithKeep();navigateTo('home');}
function getTodayCapacity(){return isHoliday(today())?(S.settings.capacityHoliday||6):(S.settings.capacityWeekday||CFG.DEFAULT_DAILY_CAPACITY);}

// ─── PURGE ───────────────────────────────────────────────────────────────────
function _purgeDoneTasks(){
  var td=today(),before=S.tasks.length;
  S.tasks=S.tasks.filter(function(t){if(t.type==='weekly')return true;if(!t.done)return true;return t.doneDate&&t.doneDate>=td;});
  if(S.tasks.length!==before)S.todayPlan=null;
}

// ─── WEEKLY ──────────────────────────────────────────────────────────────────
function isWeeklyDoneOn(t,ds){return Array.isArray(t.doneHistory)&&t.doneHistory.includes(ds);}
function isWeeklySkippedOn(t,ds){return Array.isArray(t.skipHistory)&&t.skipHistory.includes(ds);}
function markWeeklyDoneToday(id){var t=S.tasks.find(function(x){return x.id===id;});if(!t||t.type!=='weekly')return;if(!Array.isArray(t.doneHistory))t.doneHistory=[];var d=today();if(!t.doneHistory.includes(d)){t.doneHistory.push(d);var type=inferLearningType(t.title);recordCompletionHistory(type,false);recordSession(t,{type:type,wasOverdue:false});}if(Array.isArray(t.skipHistory))t.skipHistory=t.skipHistory.filter(function(x){return x!==d;});saveState();}
function unmarkWeeklyDoneToday(id){var t=S.tasks.find(function(x){return x.id===id;});if(!t||!Array.isArray(t.doneHistory))return;var d=today();t.doneHistory=t.doneHistory.filter(function(x){return x!==d;});saveState();}
function skipWeeklyToday(id){var t=S.tasks.find(function(x){return x.id===id;});if(!t||t.type!=='weekly')return;if(!Array.isArray(t.skipHistory))t.skipHistory=[];var d=today();if(!t.skipHistory.includes(d)){t.skipHistory.push(d);recordWeekdaySkip(new Date(d+'T00:00:00').getDay());}if(Array.isArray(t.doneHistory))t.doneHistory=t.doneHistory.filter(function(x){return x!==d;});saveState();rebalanceSnapshot();navigateTo('home');}
function unskipWeeklyToday(id){var t=S.tasks.find(function(x){return x.id===id;});if(!t||!Array.isArray(t.skipHistory))return;var d=today();t.skipHistory=t.skipHistory.filter(function(x){return x!==d;});saveState();rebalanceSnapshot();navigateTo('home');}

// ─── EXTRA DONE ──────────────────────────────────────────────────────────────
function markExtraDone(id){var t=S.tasks.find(function(x){return x.id===id;});if(!t)return;var td=today();if(!S.extraDoneToday||S.extraDoneToday.date!==td)S.extraDoneToday={date:td,taskIds:[],load:0};if(S.extraDoneToday.taskIds.includes(id))return;S.extraDoneToday.taskIds.push(id);S.extraDoneToday.load=(S.extraDoneToday.load||0)+(t.load||1);saveState();rebalanceSnapshot();}
function unmarkExtraDone(id){var t=S.tasks.find(function(x){return x.id===id;});if(!t||!S.extraDoneToday)return;var td=today();if(S.extraDoneToday.date!==td)return;if(!S.extraDoneToday.taskIds.includes(id))return;S.extraDoneToday.taskIds=S.extraDoneToday.taskIds.filter(function(x){return x!==id;});S.extraDoneToday.load=Math.max(0,(S.extraDoneToday.load||0)-(t.load||1));saveState();rebalanceSnapshot();}
function toggleOnceDone(id){var t=S.tasks.find(function(x){return x.id===id;});if(!t||t.type!=='once')return;var becomingDone=!t.done;t.done=becomingDone;t.doneDate=becomingDone?today():null;if(becomingDone){var wasOverdue=t.deadline&&t.deadline<today();var type=inferLearningType(t.title);recordCompletionHistory(type,wasOverdue);recordSession(t,{type:type,wasOverdue:wasOverdue});}saveState();}

// ─── SNAPSHOT ENGINE ─────────────────────────────────────────────────────────
function _ensureSnapshot(td){if(S.todayPlan&&S.todayPlan.date===td&&Array.isArray(S.todayPlan.entries))return S.todayPlan;return _generateSnapshot(td);}
function _generateSnapshot(td){
  var cap=isHoliday(td)?(S.settings.capacityHoliday||6):(S.settings.capacityWeekday||CFG.DEFAULT_DAILY_CAPACITY);
  var entries=[],usedLoad=0,ids={};
  function add(t,src,type){entries.push({id:t.id,load:t.load||1,src:src,type:type});usedLoad+=(t.load||1);ids[t.id]=true;}
  // バグ修正：スナップショットを白紙から再構成する際、本日すでに完了済みの単発タスクが
  // 候補(cands)から除外されるせいで entries に一切含まれず、達成負荷が消えてしまっていた。
  // 完了済みタスクは先に entries へ積んでおき、達成負荷を必ず保持する。
  S.tasks.filter(function(t){return t.type==='once'&&t.done&&t.doneDate===td&&!ids[t.id];}).forEach(function(t){add(t,'done','once');});
  _fillEntries(td,cap-usedLoad,entries,usedLoad,ids,add);
  S.todayPlan={date:td,entries:entries};saveState();return S.todayPlan;
}
function rebalanceSnapshot(){rebalanceWithKeep();}
function rebalanceWithKeep(){
  var td=today(),cap=isHoliday(td)?(S.settings.capacityHoliday||6):(S.settings.capacityWeekday||CFG.DEFAULT_DAILY_CAPACITY);
  var kept=[],doneLoad=0,ids={};
  if(S.todayPlan&&S.todayPlan.date===td&&Array.isArray(S.todayPlan.entries)){
    S.todayPlan.entries.forEach(function(e){var t=S.tasks.find(function(x){return x.id===e.id;});if(!t)return;var isDone=e.type==='weekly'?isWeeklyDoneOn(t,td):t.done;if(isDone){kept.push(e);doneLoad+=(e.load||1);ids[e.id]=true;}});
  }
  var extraLoad=(S.extraDoneToday&&S.extraDoneToday.date===td)?(S.extraDoneToday.load||0):0;
  _fillEntries(td,cap-doneLoad-extraLoad,kept,0,ids,function(t,src,type){kept.push({id:t.id,load:t.load||1,src:src,type:type});ids[t.id]=true;});
  S.todayPlan={date:td,entries:kept};saveState();return S.todayPlan;
}
/* ============================================================
   _fillEntries — 今日の枠にタスクを詰める中核ロジック（2026/xx 改訂）
   ------------------------------------------------------------
   「人間のキャパシティとタスクの期限に合わせて自律的に組む」という
   設計の根本に立ち返り、以下2つのおかしな挙動を修正した。

   【修正1】延滞(overdue)・本日締切(today_dl)タスクの負荷を「半分」に
   ごまかして計上していた不具合を廃止。旧実装は
     var hl=Math.max(0.5,Math.round((t.load||1)*0.5*2)/2);
   として実際の負荷の半分だけをキャパシティ計算・画面上のバッジ表示に
   使っていた。これは「延滞タスクが他の予定を全部押し出さないように」
   という意図だったと思われるが、結果として今日の水位（達成負荷）が
   実際の作業量より少なく表示され、ユーザーが「思ったより今日は重い」
   と後から気づく、という信頼性を損なう挙動になっていた。
   延滞・本日締切は先送りできない以上、実際の負荷をそのまま正直に
   計上する（キャパシティを超えても構わず含める、という制御は維持）。

   【修正2】残り容量への「詰め込み」候補が、締切ちょうど2日後のタスクだけ
   締切順で優先し、3日後以降の締切タスクは締切を無視して単に負荷の
   大きさだけで並べていた（"noDl"バケツに無条件でまとめられていた）ため、
   「3日後が締切なのに、締切のない別タスクに枠を取られて後回しにされる」
   というおかしな挙動があった。修正後は、締切のあるタスクは締切が近い順を
   最優先にし、締切がないタスクのみ最後尾へ回す一本化したロジックにした。
   ============================================================ */
function _fillEntries(td,cap,entries,_ign,ids,add){
  var dow=dayOfWeek(td),tmr=dateAddDays(td,1),iUsed=0,heavy=0;
  entries.forEach(function(e){if((e.load||1)>=4)heavy++;});
  function ac(t,src,type){add(t,src,type);var l=t.load||1;iUsed+=l;if(l>=4)heavy++;}

  // 週次タスク：曜日が一致し、今日スキップされていないものは必ず含める
  S.tasks.filter(function(t){return t.type==='weekly'&&Array.isArray(t.weekDays)&&t.weekDays.includes(dow)&&!ids[t.id]&&!isWeeklySkippedOn(t,td);}).forEach(function(t){ac(t,'weekly','weekly');});

  var cands=S.tasks.filter(function(t){if(t.type==='weekly'||t.done||ids[t.id])return false;if(t.unlockDate&&t.unlockDate>td)return false;return true;});

  // 延滞・本日締切・明日締切は、キャパシティの残量に関わらず必ず今日の枠へ含める
  // （先送りできないタスクを容量オーバーを理由に隠すことはしない）。
  // 負荷は実際の値をそのまま使う（修正1）。
  cands.filter(function(t){return t.deadline&&t.deadline<td;}).sort(function(a,b){return a.deadline.localeCompare(b.deadline);}).forEach(function(t){ac(t,'overdue','once');});
  cands.filter(function(t){return t.deadline===td&&!ids[t.id];}).forEach(function(t){ac(t,'today_dl','once');});
  cands.filter(function(t){return t.deadline===tmr&&!ids[t.id];}).forEach(function(t){ac(t,'urgent','once');});

  // 残り容量への詰め込み：締切のあるタスクは締切が近い順を最優先し、
  // 同じ締切なら負荷が大きいものを優先。締切のないタスクは最後に回す（修正2）。
  var rem=cap-iUsed;
  var rest=cands.filter(function(t){return !ids[t.id];}).sort(function(a,b){
    var ad=a.deadline?daysUntil(a.deadline,td):Infinity;
    var bd=b.deadline?daysUntil(b.deadline,td):Infinity;
    if(ad!==bd)return ad-bd;
    return(b.load||1)-(a.load||1);
  });
  var changed=true;
  while(changed&&rem>0){
    changed=false;
    for(var i=0;i<rest.length;i++){
      if(ids[rest[i].id])continue;
      var l=rest[i].load||1;
      if(l>rem)continue;
      if(l>=4&&heavy>=1)continue;
      ac(rest[i],'deadline','once');
      rem-=l;changed=true;break;
    }
  }
}

// ─── LEARNING EFFICIENCY ENGINE (vNext Phase1) ───────────────────────────────
// 入力項目は増やさない。タイトルから内部的に学習タイプを推定するのみ。
var LEARNING_TYPE_KEYWORDS={
  LOGIC:['数学','数学Ⅰ','数学Ⅱ','数学Ⅲ','数学A','数学B','数学演習','物理','化学','関数','証明','計算'],
  MEMORY:['英単語','単語','熟語','漢字','暗記','語句','用語','年号','公式暗記'],
  CREATIVE:['作文','小論文','レポート','エッセイ','創作'],
  READING:['読書','現代文','英文読解','長文','読解','古文','漢文'],
  PRACTICE:['問題集','演習','過去問','模試','ドリル','復習']
};
function inferLearningType(title){
  var n=normalizeText(title);
  if(!n)return'PRACTICE';
  var types=Object.keys(LEARNING_TYPE_KEYWORDS);
  for(var i=0;i<types.length;i++){
    var kws=LEARNING_TYPE_KEYWORDS[types[i]];
    for(var j=0;j<kws.length;j++){if(n.indexOf(normalizeText(kws[j]))!==-1)return types[i];}
  }
  return'PRACTICE';
}
var LEARNING_TYPE_LABEL={LOGIC:'論理思考',MEMORY:'暗記',CREATIVE:'創作',READING:'読解',PRACTICE:'演習'};

// 集中力モデル：時間帯ごとの内部係数（設定画面には出さない）
function getFocusCoefficient(hour){
  if(hour===undefined)hour=new Date().getHours();
  if(hour>=5&&hour<11)return{val:1.0,label:'朝'};
  if(hour>=11&&hour<17)return{val:0.85,label:'昼'};
  if(hour>=17&&hour<21)return{val:0.9,label:'夕方'};
  return{val:0.7,label:'夜'};
}
// LOGIC/CREATIVEは集中力の影響を受けやすく、MEMORY/PRACTICEは受けにくい
var TYPE_FOCUS_SENSITIVITY={LOGIC:1.0,CREATIVE:0.9,READING:0.6,PRACTICE:0.4,MEMORY:0.2};

// 疲労モデル：同一学習タイプの連続で係数が増加
var FATIGUE_STEPS=[1.0,1.2,1.5,1.8];
function fatigueMultiplier(streak){var i=Math.min(streak,FATIGUE_STEPS.length-1);return FATIGUE_STEPS[i];}

// 切替コスト：直前と学習タイプが変わる場合の小さな負荷（疲労回避との比較で相殺されうる）
function switchCost(prevType,nextType){if(!prevType||prevType===nextType)return 0;return 0.6;}

// 負荷帯の近さと学習タイプの連続を避けて、人にとって自然な組み方に寄せるための補助関数。
function getLoadBand(load){var l=Number(load)||1;if(l>=4)return 3;if(l>=3)return 2;if(l>=2)return 1;return 0;}
function normalizeTitleText(title){var s=String(title||'').toLowerCase().replace(/[^a-z0-9ぁ-んァ-ン一-龯]+/g,' ').trim();return s;}
function getTitleFamilyKey(title){
  var s=normalizeTitleText(title);
  if(!s)return'';
  s=s.replace(/\b\d+\b/g,'');
  s=s.replace(/\s+/g,' ').trim();
  var tokens=s.split(/\s+/).filter(Boolean);
  if(!tokens.length)return'';
  var first=tokens[0];
  if(first==='ワーク'||first==='work')return'ワーク';
  if(first==='問題'||first==='課題'||first==='演習'||first==='練習'||first==='テスト')return first;
  if(tokens.length>=2)return tokens.slice(0,2).join(' ');
  return tokens[0];
}
function getTitleSimilarity(a,b){
  var ta=normalizeTitleText(a),tb=normalizeTitleText(b);
  var fa=getTitleFamilyKey(a),fb=getTitleFamilyKey(b);
  if(!ta||!tb)return 0;
  if(ta===tb)return 1;
  if(fa&&fb){
    if(fa===fb)return 1;
    if((fa==='ワーク'&&fb==='ワーク')||(fa==='ワーク'&&tb.indexOf('ワーク')!==-1)||(fb==='ワーク'&&ta.indexOf('ワーク')!==-1))return 0.95;
    var aw=fa.split(/\s+/).filter(Boolean),bw=fb.split(/\s+/).filter(Boolean);
    if(!aw.length||!bw.length)return 0;
    var common=0;
    var bwSet={};
    bw.forEach(function(w){bwSet[w]=true;});
    aw.forEach(function(w){if(bwSet[w])common++;});
    var overlap=common/Math.max(1,Math.max(aw.length,bw.length));
    if(aw[0]&&bw[0]&&aw[0]===bw[0])overlap=Math.max(overlap,0.7);
    if(ta.indexOf(tb)!==-1||tb.indexOf(ta)!==-1)overlap=Math.max(overlap,0.8);
    return overlap;
  }
  var aw=ta.split(/\s+/).filter(Boolean),bw=tb.split(/\s+/).filter(Boolean);
  if(!aw.length||!bw.length)return 0;
  var bwSet={};
  bw.forEach(function(w){bwSet[w]=true;});
  var common=0;
  aw.forEach(function(w){if(bwSet[w])common++;});
  return common/Math.max(1,Math.max(aw.length,bw.length));
}
function getVarietyPenalty(task,order,type,lastType,streak){
  if(!task||!order||!order.length)return 0;
  var prevEntry=order[order.length-1];var prevTask=prevEntry&&prevEntry.task;if(!prevTask)return 0;
  var load=Number(task.load)||1;var prevLoad=Number(prevTask.load)||1;
  var band=getLoadBand(load),prevBand=getLoadBand(prevLoad);
  var penalty=0;var sameType=type===lastType;
  var recentTypes=[];
  var recentWindow=order.slice(Math.max(0,order.length-4));
  for(var i=0;i<recentWindow.length;i++){
    var recentEntry=recentWindow[i];
    if(!recentEntry)continue;
    var recentType=recentEntry.type||inferLearningType(recentEntry.task&&recentEntry.task.title);
    recentTypes.push(recentType);
  }
  var recentTypeMatches=recentTypes.filter(function(rt){return rt===type;}).length;
  var recentHeavyCount=0;
  for(var j=0;j<recentWindow.length;j++){
    var recentEntry2=recentWindow[j];
    if(!recentEntry2)continue;
    var recentBand=getLoadBand(Number(recentEntry2.task&&recentEntry2.task.load)||1);
    if(recentBand>=2)recentHeavyCount++;
  }
  var isHeavyBand=band>=2;
  var heavyStreakPenalty=0;
  if(isHeavyBand&&recentHeavyCount>=1)heavyStreakPenalty+=28+(recentHeavyCount-1)*8;
  if(!isHeavyBand&&recentHeavyCount>=1)heavyStreakPenalty-=6;
  var titlePenalty=0;
  var familyKey=getTitleFamilyKey(task.title);
  for(var k=0;k<recentWindow.length;k++){
    var recentTask=recentWindow[k]&&recentWindow[k].task;
    if(!recentTask)continue;
    var sim=getTitleSimilarity(task.title,recentTask.title);
    var recentFamilyKey=getTitleFamilyKey(recentTask.title);
    if(familyKey&&recentFamilyKey&&familyKey===recentFamilyKey){
      titlePenalty+=95;
    }else if(sim>=0.95){
      titlePenalty+=80;
    }else if(sim>=0.85){
      titlePenalty+=55;
    }else if(sim>=0.6){
      titlePenalty+=30;
    }else if(sim>=0.35){
      titlePenalty+=15;
    }
  }
  penalty+=titlePenalty;
  if(sameType)penalty+=30+(band>=2?16:0)+(streak>=2?8:0);
  if(recentTypeMatches>0)penalty+=10+(recentTypeMatches-1)*6;
  if(prevBand>=2&&band>=2)penalty+=20;
  else if(prevBand<2&&band>=2)penalty+=10;
  else if(prevBand>=2&&band<2)penalty-=10;
  penalty+=heavyStreakPenalty;
  if(recentHeavyCount>=2&&band>=2)penalty+=12;
  if(recentHeavyCount>=1&&prevBand>=2&&band>=2)penalty+=6;
  if(streak>=2&&sameType)penalty+=10;
  if(streak>=3&&sameType)penalty+=8;
  if(band===0&&prevBand>=2)penalty-=6;
  if(band===1&&prevBand>=2)penalty-=3;
  return penalty;
}

function _deadlineScoreOf(t,td){
  if(t._src==='overdue')return 100;
  if(t._src==='today_dl')return 90;
  if(t._src==='urgent')return 70;
  if(t.deadline){var d=daysUntil(t.deadline);return Math.max(0,40-d*3);}
  return 10;
}

// 履歴補正：予定負荷と実績（期限超過の有無）から内部補正係数を生成する。ユーザーへの表示は不要。
// 既存保存形式は変更しない。S.learningHistory は新規プロパティとして追加のみ。
function getHistoryCorrection(type){
  var h=S.learningHistory&&S.learningHistory[type];
  if(!h||!h.samples)return 1.0;
  return h.correction||1.0;
}
function recordCompletionHistory(type,wasOverdue){
  if(!S.learningHistory)S.learningHistory={};
  if(!S.learningHistory[type])S.learningHistory[type]={samples:0,correction:1.0};
  var h=S.learningHistory[type];
  var target=wasOverdue?Math.min(2.0,h.correction*1.15+0.05):Math.max(0.8,h.correction*0.95);
  h.correction=Math.round(((h.correction*0.7)+(target*0.3))*100)/100;
  h.samples++;
}

// おすすめ順生成：既存のpendingTasks（今日のタスク）を並べ替えるのみ。保存形式は変更しない。
// ─── ADAPTIVE LEARNING ENGINE (vNext2) ────────────────────────────────────────
// TaskNOVA自身が学習傾向を内部で学習し、次回の「おすすめ順」提案の精度を静かに上げるためのエンジン。
// 分析画面・グラフ・設定は一切追加しない。すべて内部計算にのみ使用する。
// 新規保存プロパティ：learningAnalytics / adaptiveHistory / sessionHistory（既存データには影響しない）

function _ensureAdaptiveDefaults(){
  if(!S.learningAnalytics||typeof S.learningAnalytics!=='object'||Array.isArray(S.learningAnalytics))S.learningAnalytics={bySubject:{},byWeekday:{},compressed:{}};
  if(!S.learningAnalytics.bySubject||typeof S.learningAnalytics.bySubject!=='object')S.learningAnalytics.bySubject={};
  if(!S.learningAnalytics.byWeekday||typeof S.learningAnalytics.byWeekday!=='object')S.learningAnalytics.byWeekday={};
  if(!S.learningAnalytics.compressed||typeof S.learningAnalytics.compressed!=='object')S.learningAnalytics.compressed={};
  if(!Array.isArray(S.sessionHistory))S.sessionHistory=[];
  if(!S.adaptiveHistory||typeof S.adaptiveHistory!=='object'||Array.isArray(S.adaptiveHistory))S.adaptiveHistory={recommendedCapacity:null,missStreak:0,hitStreak:0,lastCapacityUpdateDate:null,dailyCompletion:{}};
  if(!S.adaptiveHistory.dailyCompletion||typeof S.adaptiveHistory.dailyCompletion!=='object')S.adaptiveHistory.dailyCompletion={};
}

// ① Learning Analytics：1件の完了を記録する（教科別実績・曜日別実績・負荷実績・完了までの日数・開始/終了時刻）
// ユーザーには一切表示しない。新しい入力は増やさず、既存のtask情報と完了タイミングのみから推定する。
function recordSession(t,opts){
  _ensureAdaptiveDefaults();
  opts=opts||{};
  var type=opts.type||inferLearningType(t.title);
  var nowTs=Date.now(),dateStr=today();
  var wd=new Date(dateStr+'T00:00:00').getDay();
  var plannedLoad=t.load||1;
  var wasOverdue=!!opts.wasOverdue;
  // 実績負荷は新規入力を増やさず、期限超過の有無から間接的に推定する（超過＝見積り不足の兆候）
  var actualLoad=wasOverdue?Math.round(plannedLoad*1.3*10)/10:Math.round(plannedLoad*0.95*10)/10;
  var createdAt=t.createdAt||nowTs;
  var daysToComplete=Math.max(0,Math.round((nowTs-createdAt)/86400000));
  S.sessionHistory.push({date:dateStr,weekday:wd,type:type,plannedLoad:plannedLoad,actualLoad:actualLoad,
    wasOverdue:wasOverdue,daysToComplete:daysToComplete,startAt:createdAt,endAt:nowTs,taskId:t.id});
  _compressSessionHistory();

  var subj=S.learningAnalytics.bySubject[type]||{plannedTotal:0,actualTotal:0,completions:0,daysToCompleteTotal:0};
  subj.plannedTotal+=plannedLoad;subj.actualTotal+=actualLoad;subj.completions++;subj.daysToCompleteTotal+=daysToComplete;
  S.learningAnalytics.bySubject[type]=subj;

  var wdStat=S.learningAnalytics.byWeekday[wd]||{completed:0,missed:0};
  if(wasOverdue)wdStat.missed++;else wdStat.completed++;
  S.learningAnalytics.byWeekday[wd]=wdStat;

  var dc=S.adaptiveHistory.dailyCompletion;
  dc[dateStr]=(dc[dateStr]||0)+plannedLoad;
  _pruneDailyCompletion();
}
// 週次タスクのスキップも曜日別「未達」として記録する（③曜日補正の学習材料）
function recordWeekdaySkip(wd){
  _ensureAdaptiveDefaults();
  var wdStat=S.learningAnalytics.byWeekday[wd]||{completed:0,missed:0};
  wdStat.missed++;
  S.learningAnalytics.byWeekday[wd]=wdStat;
}
// パフォーマンス対策：sessionHistoryは365日程度に制限し、古いものは月次集計へ圧縮してから間引く
function _compressSessionHistory(){
  var LIMIT=365;
  if(S.sessionHistory.length<=LIMIT)return;
  var old=S.sessionHistory.splice(0,S.sessionHistory.length-LIMIT);
  old.forEach(function(s){
    var ym=s.date.slice(0,7);
    var c=S.learningAnalytics.compressed[ym]||{plannedTotal:0,actualTotal:0,completions:0};
    c.plannedTotal+=s.plannedLoad;c.actualTotal+=s.actualLoad;c.completions++;
    S.learningAnalytics.compressed[ym]=c;
  });
}
function _pruneDailyCompletion(){
  var dc=S.adaptiveHistory.dailyCompletion,keys=Object.keys(dc).sort(),LIMIT=60;
  while(keys.length>LIMIT){delete dc[keys.shift()];}
}

// ⑥ Confidence Score：サンプル数から0〜1の内部信頼度を返す。表示はしないが各種補正の重み付けに使う。
function getConfidenceScore(type){
  _ensureAdaptiveDefaults();
  var subj=S.learningAnalytics.bySubject[type];
  var samples=subj?subj.completions:0;
  return Math.max(0,Math.min(1,samples/10));
}

// ② 教科補正：教科ごとの予定負荷/実績負荷の比率から補正係数を得る（例：予定3・実績4.2→補正1.4）。
// サンプルが少ないうちはConfidence Scoreで1.0側へ減衰させ、過剰反応を防ぐ。
function getSubjectCorrection(type){
  _ensureAdaptiveDefaults();
  var subj=S.learningAnalytics.bySubject[type];
  if(!subj||subj.completions<2||subj.plannedTotal<=0)return 1.0;
  var raw=subj.actualTotal/subj.plannedTotal;
  var confidence=getConfidenceScore(type);
  return 1+(raw-1)*confidence;
}

/* ============================================================
   ③ 曜日補正（修正済み）
   ------------------------------------------------------------
   旧実装は「rate>=0.85なら常に1.0を返す」という特別扱いのせいで、
   rate=0.849→係数0.955、rate=0.85→係数1.0、と関数の連続性が
   その一点だけ不自然に飛ぶ（段差ができる）計算式になっていた。
   0.7+rate*0.3 という式自体、rate=1の時にちょうど1.0になるため
   分岐は不要だった。分岐を削除し、常になだらかな式一本にした。
   ============================================================ */
function getWeekdayAdjustment(wd){
  _ensureAdaptiveDefaults();
  var s=S.learningAnalytics.byWeekday[wd];
  if(!s||(s.completed+s.missed)<3)return 1.0;
  var rate=s.completed/(s.completed+s.missed);
  return Math.max(0.7,Math.min(1,0.7+rate*0.3));
}

// ④ キャパシティ補正：ユーザー設定のキャパシティ自体は変更せず、内部推奨キャパシティのみを保持・調整する。
// 実績平均より5〜10%高めを目安にしつつ、未達が続く場合のみ緩やかに引き下げる。
function getRecommendedCapacity(baseCapacity){
  _ensureAdaptiveDefaults();
  var ah=S.adaptiveHistory;
  if(ah.recommendedCapacity==null)ah.recommendedCapacity=Math.round(baseCapacity*1.075*10)/10;
  return ah.recommendedCapacity;
}
// 日付が変わったタイミングで1日1回だけ呼び出し、前日の実績を見て推奨キャパシティを更新する
function updateRecommendedCapacityForNewDay(baseCapacity){
  _ensureAdaptiveDefaults();
  var ah=S.adaptiveHistory,td=today();
  if(ah.lastCapacityUpdateDate===td)return;
  var yest=dateAddDays(td,-1),yestLoad=ah.dailyCompletion[yest]||0;
  var target=getRecommendedCapacity(baseCapacity);
  if(yestLoad>0){
    if(yestLoad>=target*0.9){ah.hitStreak++;ah.missStreak=0;}
    else{ah.missStreak++;ah.hitStreak=0;}
  }
  if(ah.missStreak>=3){ah.recommendedCapacity=Math.max(baseCapacity,Math.round(target*0.95*10)/10);ah.missStreak=0;}
  else if(ah.hitStreak>=5){var capMax=Math.round(baseCapacity*1.10*10)/10;ah.recommendedCapacity=Math.min(capMax,Math.round(target*1.02*10)/10);ah.hitStreak=0;}
  ah.lastCapacityUpdateDate=td;
}

// ⑤ 達成率予測：曜日傾向と負荷/推奨キャパシティ比から今日の達成率を内部推定する。アルゴリズム内部でのみ使用し、表示はしない。
function predictTodayAchievementRate(pendingLoad,baseCapacity){
  _ensureAdaptiveDefaults();
  var wd=new Date(today()+'T00:00:00').getDay();
  var s=S.learningAnalytics.byWeekday[wd];
  var base=(s&&(s.completed+s.missed)>=3)?s.completed/(s.completed+s.missed):0.8;
  var cap=getRecommendedCapacity(baseCapacity);
  var loadRatio=cap>0?Math.min(2,pendingLoad/cap):1;
  var adj=loadRatio<=1?1:Math.max(0.4,1-(loadRatio-1)*0.5);
  return Math.max(0.1,Math.min(1,base*adj));
}

// ─── REASON BUILDER（おすすめ順の理由生成を専任で担うモジュール）─────────────
// 責務：内部スコア（締切/負荷/集中/教科/曜日/履歴など）を、アルゴリズムを一切露出しない
// 自然な日本語の「理由」に翻訳する。表示は常に上位2件まで（この上限は変更しない）。
var ReasonBuilder=(function(){
  // カテゴリごとの言い回しバリエーション。同じ状況でも表現に幅を持たせ、単調な繰り返しを防ぐ。
  var PHRASES={
    load:['今日の負荷に合っている配置','重い課題を先に処理','軽めの課題で調整','今日は無理なく進められる組み立て'],
    overall:['全体のバランスを考慮','偏りを防ぐ配置','今日全体の効率を優先','無理のない組み立て']
  };
  // タスク固有の値から言い回しを決定的に選ぶ（毎回ランダムだと不安定なので、タスクIDベースで安定選択）
  function _hash(s){s=String(s||'');var h=0;for(var i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))|0;}return Math.abs(h);}
  function pick(category,seed){var arr=PHRASES[category];if(!arr||!arr.length)return null;return arr[_hash(seed)%arr.length];}
  function mk(id,category,priority,text){return{id:id,category:category,priority:priority,text:text};}

  // 個々のタスクについて、内部スコアの計算結果(info)から「理由候補」を洗い出す
  function collect(t,info,focus,prevType){
    var seed=t.id||t.title||'',list=[];
    if(t._src==='overdue'||t._src==='today_dl')list.push(mk('deadline_today','deadline',100,'締切が近い'));
    else if(t._src==='urgent')list.push(mk('deadline_tomorrow','deadline',90,'明日が締切'));
    if(info.subjectBonus>=8)list.push(mk('subject_slow','subject',85,'あなたはこの教科に時間がかかる傾向があるため先に配置'));
    if(info.focusBonus>=10)list.push(mk('focus_high','focus',70,focus.label+'は集中力が高い時間帯'));
    if(info.historyBonus>=6)list.push(mk('history_good','history',60,'過去の実績から余裕を持って早めに配置'));
    if(prevType&&prevType!==info.type&&(prevType==='LOGIC'||prevType==='READING')&&info.type==='MEMORY'){
      list.push(mk('cognitive_switch_memory','cognitive',55,'論理思考の後は暗記系で負荷分散'));
    }else if(info.isSameType&&info.fatiguePenalty>0){
      list.push(mk('cognitive_fatigue','cognitive',50,'連続を避けたいが優先度が高い'));
    }else if(prevType&&prevType!==info.type){
      list.push(mk('cognitive_general','cognitive',45,'タイプを変えて認知負荷を分散'));
    }
    if(info.weekdayBonus<-2)list.push(mk('load_weekday','load',40,pick('load',seed)));
    if(list.length===0)list.push(mk('overall_default','overall',10,pick('overall',seed)));
    return list;
  }
  // priority順に並べ、同一カテゴリの重複を避けつつ上位2件だけを採用して表示用テキストへ変換する
  function build(t,info,focus,prevType){
    var reasons=collect(t,info,focus,prevType);
    reasons.sort(function(a,b){return b.priority-a.priority;});
    var seen={},picked=[];
    for(var i=0;i<reasons.length&&picked.length<2;i++){
      if(seen[reasons[i].category])continue;
      seen[reasons[i].category]=true;picked.push(reasons[i]);
    }
    return picked.map(function(r){return r.text;}).join('・');
  }
  return{build:build};
})();

function generateRecommendedOrder(pending){
  if(!Array.isArray(pending)||pending.length===0)return[];
  var td=today(),focus=getFocusCoefficient(),remaining=pending.slice(),order=[],lastType=null,streak=0;
  var baseCapacity=getTodayCapacity(),recCapacity=getRecommendedCapacity(baseCapacity);
  var totalPendingLoad=pending.reduce(function(s,t){return s+(t.load||0);},0);
  var predictedRate=predictTodayAchievementRate(totalPendingLoad,baseCapacity);
  var wd=new Date(td+'T00:00:00').getDay(),weekdayAdj=getWeekdayAdjustment(wd);
  var runningLoad=0;
  while(remaining.length>0){
    var best=null,bestScore=-Infinity,bestInfo=null;
    for(var i=0;i<remaining.length;i++){
      var t=remaining[i];
      var type=t.type==='weekly'?'PRACTICE':inferLearningType(t.title);
      var dScore=_deadlineScoreOf(t,td);
      if(predictedRate<0.6)dScore*=1.15; // 達成率予測が低い日は締切系をより前倒し
      var sens=TYPE_FOCUS_SENSITIVITY[type]||0.4;
      var focusBonus=focus.val*sens*20;
      var isSameType=(type===lastType);
      var fatiguePenalty=isSameType?(fatigueMultiplier(streak)-1)*15:0;
      var switchPenalty=(!isSameType&&lastType)?switchCost(lastType,type)*5:0;
      var correction=getHistoryCorrection(type);
      var historyBonus=(correction-1)*20;
      var subjectCorrection=getSubjectCorrection(type);
      var subjectBonus=(subjectCorrection-1)*15;
      var weekdayBonus=-(1-weekdayAdj)*(t.load||1)*5; // 達成率の低い曜日ほど重いタスクを僅かに後ろへ
      var capacityScore=(runningLoad+(t.load||0)<=recCapacity)?3:-3;
      var varietyPenalty=getVarietyPenalty(t,order,type,lastType,streak);
      var score=dScore+focusBonus+historyBonus+subjectBonus+weekdayBonus+capacityScore-fatiguePenalty-switchPenalty-varietyPenalty;
      if(score>bestScore){bestScore=score;best=t;bestInfo={type:type,dScore:dScore,focusBonus:focusBonus,fatiguePenalty:fatiguePenalty,switchPenalty:switchPenalty,historyBonus:historyBonus,subjectBonus:subjectBonus,subjectCorrection:subjectCorrection,weekdayBonus:weekdayBonus,isSameType:isSameType};}
    }
    var reason=ReasonBuilder.build(best,bestInfo,focus,lastType);
    order.push({task:best,type:bestInfo.type,reason:reason});
    remaining=remaining.filter(function(x){return x.id!==best.id;});
    runningLoad+=best.load||0;
    if(bestInfo.isSameType)streak++;else streak=0;
    lastType=bestInfo.type;
  }
  return order;
}

// ─── TODAY STATS ─────────────────────────────────────────────────────────────
function getTodayStats(){
  var td=today(),snap=_ensureSnapshot(td);
  var cap=isHoliday(td)?(S.settings.capacityHoliday||6):(S.settings.capacityWeekday||CFG.DEFAULT_DAILY_CAPACITY);
  var total=0,done=0,pending=[];
  snap.entries.forEach(function(e){var t=S.tasks.find(function(x){return x.id===e.id;});if(!t)return;var isDone=e.type==='weekly'?isWeeklyDoneOn(t,td):t.done;total+=e.load;if(isDone)done+=e.load;else pending.push(Object.assign({},t,{_src:e.src,_snapLoad:e.load}));});
  var extra=0;
  if(S.extraDoneToday&&S.extraDoneToday.date===td){S.extraDoneToday.taskIds.forEach(function(id){var inSnap=snap.entries.some(function(e){return e.id===id;});if(!inSnap){var t=S.tasks.find(function(x){return x.id===id;});if(t)extra+=(t.load||1);}});}
  done+=extra;total+=extra;
  return{capacity:cap,totalLoad:total,doneLoad:done,remainingCapacity:cap-done,pendingTasks:pending,capacityReached:done>=cap,allDone:pending.length===0&&total>0};
}
function resetTodayPlan(){S.todayPlan=null;saveState();}
function removeFromSnapshot(id){
  if(!S.todayPlan||!Array.isArray(S.todayPlan.entries))return;
  S.todayPlan.entries=S.todayPlan.entries.filter(function(e){return e.id!==id;});
  if(S.extraDoneToday&&Array.isArray(S.extraDoneToday.taskIds)){var t=S.tasks.find(function(x){return x.id===id;});if(t&&S.extraDoneToday.taskIds.includes(id)){S.extraDoneToday.taskIds=S.extraDoneToday.taskIds.filter(function(x){return x!==id;});S.extraDoneToday.load=Math.max(0,(S.extraDoneToday.load||0)-(t.load||1));}}
  saveState();
}

// ─── SIMULATE ────────────────────────────────────────────────────────────────
function simulateEarliestCompletion(){
  var pending=S.tasks.filter(function(t){return t.type!=='weekly'&&!t.done;});
  if(pending.length===0)return null;
  var td=today(),simDate=td,remaining=pending.slice(),maxDays=365,day=0;
  while(remaining.length>0&&day<maxDays){
    var cap=isHoliday(simDate)?(S.settings.capacityHoliday||6):(S.settings.capacityWeekday||CFG.DEFAULT_DAILY_CAPACITY);
    if(simDate===td){var el=(S.extraDoneToday&&S.extraDoneToday.date===td)?(S.extraDoneToday.load||0):0;var sdl=0;if(S.todayPlan&&S.todayPlan.date===td){S.todayPlan.entries.forEach(function(e){var t=S.tasks.find(function(x){return x.id===e.id;});if(!t)return;var isDone=e.type==='weekly'?isWeeklyDoneOn(t,td):t.done;if(isDone)sdl+=e.load;});}cap=Math.max(0,cap-el-sdl);}
    var selected=[],used=0,heavy=0;
    var candidates=remaining.filter(function(t){if(t.unlockDate&&t.unlockDate>simDate)return false;return true;}).slice().sort(function(a,b){
      var aDeadline=a.deadline||null,bDeadline=b.deadline||null;
      var aUrg=aDeadline?daysUntil(aDeadline,simDate):Infinity;
      var bUrg=bDeadline?daysUntil(bDeadline,simDate):Infinity;
      if(aDeadline&&bDeadline){var dc=aDeadline.localeCompare(bDeadline);if(dc!==0)return dc;}
      else if(aDeadline&&!bDeadline)return -1;
      else if(!aDeadline&&bDeadline)return 1;
      if(aUrg!==bUrg){return aUrg-bUrg;}
      return (b.load||1)-(a.load||1);
    });
    for(var i=0;i<candidates.length;i++){
      var t=candidates[i];
      var l=t.load||1;
      if(used+l>cap)continue;
      if(l>=4&&heavy>=1)continue;
      selected.push(t);used+=l;if(l>=4)heavy++;}
    remaining=remaining.filter(function(t){return !selected.some(function(s){return s.id===t.id;});});
    if(remaining.length===0)break;
    simDate=dateAddDays(simDate,1);day++;
  }
  return remaining.length===0?simDate:null;
}

// ─── EXPORT / IMPORT ─────────────────────────────────────────────────────────
function exportData(){var b=new Blob([JSON.stringify(S,null,2)],{type:'application/json'});var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='TaskNOVA_save_data.json';a.click();showToast('エクスポート完了');}
function importData(ev){var f=ev.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(e){try{var p=JSON.parse(e.target.result);if(typeof p!=='object'||Array.isArray(p)){showToast('エラー：データ形式が不正です');return;}if(!Array.isArray(p.tasks))p.tasks=[];p.tasks=p.tasks.map(function(t){return Object.assign({},t,{title:sanitize(t.title||'')});});S=Object.assign({},S,p);saveState();showToast('インポート完了');navigateTo('home');}catch(e){showToast('エラー：ファイルが無効です');}};r.readAsText(f);}

// ─── UI HELPERS ──────────────────────────────────────────────────────────────
/* ============================================================
   animateNumberEl — 数値のカウントアップ演出
   ------------------------------------------------------------
   renderHome()/renderSettings()が data-to="実際の値" を持たせた
   要素を0から実際の値まで一定時間かけてカウントアップする。
   HTML文字列を生成する既存のrender関数自体は変更せず、
   「data-toを持つ要素を後から探して animateする」という
   完全に加算的な仕組みにすることで、既存の描画ロジックには
   一切手を触れていない。
   ============================================================ */
function animateNumberEl(el){
  var to=parseFloat(el.getAttribute('data-to'));
  if(!isFinite(to)){return;}
  var decimals=parseInt(el.getAttribute('data-decimals')||'0',10);
  var duration=420,start=null;
  function step(ts){
    if(!start)start=ts;
    var p=Math.min(1,(ts-start)/duration);
    var eased=1-Math.pow(1-p,3);
    var val=to*eased;
    el.textContent=decimals>0?val.toFixed(decimals):Math.round(val);
    if(p<1)requestAnimationFrame(step);
    else el.textContent=decimals>0?to.toFixed(decimals):String(Math.round(to));
  }
  requestAnimationFrame(step);
}
function animateNumbersIn(root){
  (root||document).querySelectorAll('[data-to]').forEach(function(el){animateNumberEl(el);});
}
var _toastTimer;
function showToast(msg){var el=document.getElementById('toast');clearTimeout(_toastTimer);el.textContent=msg;el.classList.add('show');_toastTimer=setTimeout(function(){el.classList.remove('show');},2600);}
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}

function loadBadge(v){var c=loadColor(parseFloat(v)||1),l=loadLabel(parseFloat(v)||1);return'<span class="badge" style="background:'+c+'18;color:'+c+';border-color:'+c+'30">'+l+'</span>';}

// ─── SIDEBAR TOGGLE (index.html方式) ─────────────────────────────────────────
function toggleSidebar(){
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
var currentPage=null;
function navigateTo(page){
  currentPage=page;
  document.querySelectorAll('.nav-item[data-page]').forEach(function(b){b.classList.toggle('active',b.dataset.page===page);});
  var mc=document.getElementById('main-content');
  mc.classList.add('page-fade-out');
  // 恒星系(home)・タスクフィールド(tasks)はどちらもWebGLコンテキストを
  // 1つ占有する。iOS Safariはコンテキスト数の上限が特に厳しいため、
  // 行き先がそのページでなければ必ず先に破棄してから遷移する。
  if(window.SolarSystem&&currentPage!=='home')window.SolarSystem.dispose();
  if(window.TaskField&&currentPage!=='tasks')window.TaskField.dispose();
  mc.innerHTML=renderPage(page);
  postRender(page);
  closeSidebar();
  // 画面遷移フェード：一度透明化した状態でコンテンツを差し替え、次のフレームでふわっと戻す（0.15s）
  requestAnimationFrame(function(){requestAnimationFrame(function(){mc.classList.remove('page-fade-out');});});
}
function renderPage(page){switch(page){case'home':return renderHome();case'tasks':return renderTasksPage();case'settings':return renderSettings();default:return renderHome();}}
function postRender(page){
  if(page==='settings'){
    var slW=document.getElementById('capacity-slider-weekday');
    if(slW){slW.value=S.settings.capacityWeekday||CFG.DEFAULT_DAILY_CAPACITY;updateDialVisual('weekday',slW.value);}
    var slH=document.getElementById('capacity-slider-holiday');
    if(slH){slH.value=S.settings.capacityHoliday||6;updateDialVisual('holiday',slH.value);}
  }
  if(page==='home'&&window.SolarSystem){
    // type=moduleスクリプトの読込・初期化が完了しているとは限らないため、
    // 準備できるまで短い間隔でリトライする(見た目上は#solar-loadingが
    // 表示され続けるだけで、ユーザーには自然な「読み込み中」に見える)。
    var tries=0;
    (function tryInit(){
      if(window.SolarSystem.ready){window.SolarSystem.init(getTodaySolarTasks());return;}
      if(++tries>200)return; // 約10秒でタイムアウト、諦める(回線不良等)
      setTimeout(tryInit,50);
    })();
  }
  if(page==='tasks'&&window.TaskField){
    var triesF=0;
    (function tryInitF(){
      if(window.TaskField.ready){window.TaskField.init(getPoolTasks());return;}
      if(++triesF>200)return;
      setTimeout(tryInitF,50);
    })();
  }
  animateNumbersIn(document.getElementById('main-content'));
}
function doRecompute(){rebalanceWithKeep();navigateTo('home');showToast('スケジュールを再計算しました');}


// ─── HOME（架空恒星系）───────────────────────────────────────────────────────
// 「今日」ページは太陽系(恒星系)だけを表示する。リング・リストは撤去し、
// タスクの締切(軌道半径)・負荷(天体の大きさ)を太陽系そのものとして描く。
// 実際の天体シーン構築・操作はjs/solar-system.js(type=moduleスクリプト、
// 本ファイル末尾で読込)が担当し、ここではステージのDOMの骨組みのみ返す。
function renderHome(){
  var td=today(),d=new Date(td+'T00:00:00'),dow=d.getDay();
  var dateLabel=(d.getMonth()+1)+'月'+d.getDate()+'日（'+CFG.WEEKDAY_NAMES[dow]+'）';
  // #solar-stageはposition:fixedで画面全体(ヘッダー〜タブバー間)を専有するため、
  // この関数が返すHTML自体は#main-content内で高さを持たせない(page-wrap由来の
  // 上下パディングが余白として残るのを防ぐ)。
  return '<div style="height:0;overflow:visible">'+
      '<div id="solar-stage">'+
      '<canvas id="solar-canvas"></canvas>'+
      '<div id="solar-caption">'+dateLabel+'・恒星系</div>'+
      '<div id="solar-hint">ドラッグで視点回転・ピンチでズーム・天体をタップ</div>'+
      '<div id="solar-loading"><div class="solar-spinner"></div><span>恒星系を構築中…</span></div>'+
      '<div id="solar-empty"><div class="se-icon">✧</div><p>まだ天体がありません<br>右下の＋からタスクを追加すると恒星系ができます</p></div>'+
      '<div id="solar-label"><div class="sl-title" id="sl-title"></div><div class="sl-meta" id="sl-meta"></div><div class="sl-hint" id="sl-hint">もう一度タップで完了</div></div>'+
    '</div>'+
  '</div>';
}

// 太陽系モジュール(js/solar-system.js相当、type=module)へ渡すための
// 「今日の全タスク(完了済みも含む)」データ。getTodayStats().pendingTasksは
// 未完了だけを返す設計のため、恒星系表示専用にここで別途組み立てる。
function getTodaySolarTasks(){
  var td=today(),snap=_ensureSnapshot(td);
  var out=[];
  snap.entries.forEach(function(e){
    var t=S.tasks.find(function(x){return x.id===e.id;});
    if(!t)return;
    var isWeekly=e.type==='weekly';
    var isDone=isWeekly?isWeeklyDoneOn(t,td):t.done;
    var dueDays=null;
    if(!isWeekly&&t.deadline)dueDays=daysUntil(t.deadline,td);
    if(e.src==='today_dl')dueDays=0;
    else if(e.src==='urgent'&&dueDays==null)dueDays=1;
    out.push({
      id:t.id,title:t.title,load:e.load||t.load||1,
      isWeekly:isWeekly,isDone:isDone,dueDays:dueDays,
      isOverdue:e.src==='overdue',
    });
  });
  return out;
}

// 「タスク」タブ(浮遊フィールド)向け：今日のキャパシティ選定を経由せず、
// 未完了の全タスク(単発＋今日まだ完了していない週次)をそのまま返す。
// 「今日」の恒星系が"今日消化する分だけの秩序だった軌道系"であるのに対し、
// フィールドは"手つかずの案件が無造作に浮かぶ深宇宙"という位置づけのため、
// キャパシティによる絞り込みは行わない。
function getPoolTasks(){
  var td=today(),out=[];
  S.tasks.forEach(function(t){
    var isWeekly=t.type==='weekly';
    var learningType=inferLearningType(t.title);
    if(isWeekly){
      if(isWeeklyDoneOn(t,td))return;
      out.push({id:t.id,title:t.title,load:t.load||1,isWeekly:true,isDone:false,dueDays:null,isOverdue:false,learningType:learningType});
    }else{
      if(t.done)return;
      if(t.unlockDate&&t.unlockDate>td)return;
      var dueDays=t.deadline?daysUntil(t.deadline,td):null;
      out.push({id:t.id,title:t.title,load:t.load||1,isWeekly:false,isDone:false,dueDays:dueDays,isOverdue:dueDays!=null&&dueDays<0,learningType:learningType});
    }
  });
  return out;
}


// ─── ANIMATION（画面遷移・タスク完了などの演出を担うモジュール）───────────────
// opacity/translate/scaleのみを使用する、控えめで自然な演出に限定する。
var Animation=(function(){
  // 完了操作の見た目：右へフェードアウト（0.2s）してから実際の状態更新・再描画を行う
  function taskExit(id,cb){
    var el=document.querySelector('[data-task-row="'+id+'"]');
    if(!el){cb();return;}
    el.classList.add('task-exit');
    setTimeout(cb,200);
  }
  return{taskExit:taskExit};
})();
/* ============================================================
   ホーム画面からのタスク完了/未完了トグル（修正済み）
   ------------------------------------------------------------
   旧実装は完了状態を更新するだけで、今日の枠の再計算(rebalance)を
   一切行っていなかった。そのため、あるタスクを完了しても、空いた
   キャパシティへ次のタスクが自動的に流し込まれず、「まだ余裕が
   あるのに何も提案されない」という、キャパシティに合わせて自律的に
   タスクを組むという設計思想に反する挙動になっていた。
   完了/取り消しのたびに rebalanceWithKeep() を呼び、空いた分（あるいは
   取り消しで減った分）を即座に埋め直すようにした。
   ============================================================ */
// ─── TASKS PAGE ──────────────────────────────────────────────────────────────
var _editingTaskId=null,_deletingTaskId=null;

function renderTasksPage(){
  var pool=getPoolTasks();
  var simHtml='';
  if(pool.some(function(t){return!t.isWeekly;})){
    var sd=simulateEarliestCompletion(),sc='sim-date',st='';
    if(!sd){st='なし';sc+=' none';}else if(sd===today()){st='今日';}
    else{var sdd=new Date(sd+'T00:00:00');st=(sdd.getMonth()+1)+'/'+ sdd.getDate()+'（'+CFG.WEEKDAY_NAMES[sdd.getDay()]+'）';}
    simHtml='<div class="sim-widget"><span class="sim-label">最速完了</span><span class="'+sc+'">'+st+'</span></div>';
  }
  // #field-stageはposition:fixedで画面全体(ヘッダー〜タブバー間)を専有するため、
  // この関数が返すHTML自体は#main-content内で高さを持たせない(#solar-stageと
  // 同じ方針)。ページ見出しだけは#field-stageより上のドキュメントフローに残す。
  return '<div class="page-wrap" style="padding-bottom:24px">'+
    '<div class="page-head">'+
      '<div class="page-eyebrow">DEEP FIELD SCAN</div>'+
      '<div class="page-head-row"><div class="page-title-main">タスク</div>'+simHtml+'</div>'+
    '</div>'+
  '</div>'+
  '<div style="height:0;overflow:visible">'+
    '<div id="field-stage">'+
    '<canvas id="field-canvas"></canvas>'+
    '<div id="field-caption">'+pool.length+'件</div>'+
    '<div id="field-legend">'+
      '<div class="fl-item"><span class="fl-sw" style="background:#6ea8e6"></span>論理思考</div>'+
      '<div class="fl-item"><span class="fl-sw" style="background:#d6a84a"></span>暗記</div>'+
      '<div class="fl-item"><span class="fl-sw" style="background:#c864be"></span>創作</div>'+
      '<div class="fl-item"><span class="fl-sw" style="background:#60c896"></span>読解</div>'+
      '<div class="fl-item"><span class="fl-sw" style="background:#aa82dc"></span>演習</div>'+
    '</div>'+
    '<div id="field-hint">ドラッグで視点回転・ピンチでズーム・天体をタップ</div>'+
    '<div id="field-cockpit-frame"><div class="fc-arc left"></div><div class="fc-arc right"></div><div class="fc-bottom-fade"></div></div>'+
    '<div id="field-loading"><div class="solar-spinner"></div><span>タスクフィールドを読込中…</span></div>'+
    '<div id="field-empty"><div class="fe-icon">✧</div><p>タスクはありません<br>右下の＋から追加すると天体が浮かびます</p></div>'+
    '<svg id="field-leader"><defs><linearGradient id="leaderFade" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="var(--accent)" stop-opacity="0.9"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0.15"/></linearGradient></defs><path id="field-leader-glow" class="leader-glow" d=""></path><circle class="term-dot" id="field-leader-dot" r="2.5" cx="0" cy="0"></circle></svg>'+
    '<div id="field-callout">'+
      '<div class="fc-title" id="fc-title"></div>'+
      '<div class="fc-meta" id="fc-meta"></div>'+
      '<div class="fc-actions">'+
        '<button class="fc-btn fc-edit" id="fc-edit-btn" aria-label="編集"><svg viewBox="0 0 24 24" fill="none"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>編集</button>'+
        '<button class="fc-btn fc-complete" id="fc-complete-btn" aria-label="達成"><svg viewBox="0 0 24 24" fill="none"><polyline points="20,6 9,17 4,12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>達成</button>'+
      '</div>'+
    '</div>'+
    '</div>'+
  '</div>';
}

// フィールド上の天体を「達成」した時の共通処理。単発タスクは完了フラグを
// 立て、週次タスクは今日分の完了記録を付ける。どちらもUI上は同じ
// 「達成ボタンを押すと天体が消える」という一貫した体験にする。
function completePoolTask(id,isWeekly){
  if(isWeekly){markWeeklyDoneToday(id);}
  else{toggleOnceDone(id);}
  rebalanceWithKeep();
  // 天体そのものの消滅演出はtask-field.js側(completeBody)が既に担当して
  // いるため、ここでnavigateTo('tasks')は呼ばない(呼ぶとシーンが
  // 作り直されてパーティクル演出の途中でフィールドが再構築されてしまう)。
  // 見出しの「◯件浮遊中」カウントだけはこの場で直接更新する。
  var cap=document.getElementById('field-caption');
  if(cap)cap.textContent=getPoolTasks().length+'件 浮遊中';
}

// ─── TASK MODAL ──────────────────────────────────────────────────────────────
function openAddTask(){_editingTaskId=null;resetTaskModal();document.getElementById('modal-task-title').textContent='タスクを追加';document.getElementById('modal-task-delete').style.display='none';setTaskType('once');setTimeout(function(){updateLoadSlider(3);},0);openModal('modal-task');}
function openEditTask(id){var t=S.tasks.find(function(x){return x.id===id;});if(!t)return;_editingTaskId=id;resetTaskModal();document.getElementById('modal-task-title').textContent='タスクを編集';document.getElementById('modal-task-delete').style.display='block';document.getElementById('input-task-title').value=t.title||'';setTaskType(t.type||'once');if(t.type==='weekly'){var wd=t.weekDays||[];document.querySelectorAll('.wd-btn').forEach(function(b){b.classList.toggle('active',wd.includes(+b.dataset.dow));});}else{document.getElementById('input-task-deadline').value=t.deadline||'';document.getElementById('input-task-unlock').value=t.unlockDate||'';}setLoadSlider(t.load||3);openModal('modal-task');}
function resetTaskModal(){document.getElementById('input-task-title').value='';document.getElementById('input-task-deadline').value='';document.getElementById('input-task-unlock').value='';setLoadSlider(3);document.querySelectorAll('.wd-btn').forEach(function(b){b.classList.remove('active');});}
function setTaskType(type){var isW=type==='weekly';document.querySelectorAll('.type-btn').forEach(function(b){b.classList.toggle('active',b.dataset.type===type);});document.getElementById('deadline-row').style.display=isW?'none':'';document.getElementById('unlock-row').style.display=isW?'none':'';document.getElementById('weekdays-row').style.display=isW?'':'none';}
function updateLoadSlider(val){var v=parseFloat(val),badge=document.getElementById('load-slider-badge'),hint=document.getElementById('load-slider-hint');if(!badge)return;var c=loadColor(v),l=loadLabel(v);badge.textContent=l;badge.style.background=c+'18';badge.style.color=c;badge.style.borderColor=c+'30';var hints={0.5:'〜15分',1:'〜30分',1.5:'〜45分',2:'〜1時間',2.5:'〜1.5時間',3:'〜2時間',3.5:'〜2.5時間',4:'〜3時間',4.5:'〜4時間',5:'4時間超'};if(hint)hint.textContent=hints[v]||'';}
function getLoadValue(){var sl=document.getElementById('load-slider');return sl?parseFloat(sl.value):3;}
function setLoadSlider(val){var sl=document.getElementById('load-slider');if(sl){sl.value=val;updateLoadSlider(val);}}
function toggleWeekday(btn){btn.classList.toggle('active');}
function getSelectedWeekdays(){return Array.from(document.querySelectorAll('.wd-btn.active')).map(function(b){return+b.dataset.dow;});}
function saveTask(){
  var title=document.getElementById('input-task-title').value.trim();
  var deadline=document.getElementById('input-task-deadline').value;
  var unlock=document.getElementById('input-task-unlock').value;
  var load=getLoadValue();
  var typeEl=document.querySelector('.type-btn.active');
  var type=typeEl?typeEl.dataset.type:'once';
  var weekDays=type==='weekly'?getSelectedWeekdays():[];
  if(!title){showToast('タイトルを入力してください');document.getElementById('input-task-title').focus();return;}
  if(type==='weekly'&&weekDays.length===0){showToast('繰り返す曜日を選択してください');var firstWeekday=document.querySelector('.wd-btn');if(firstWeekday)firstWeekday.focus();return;}
  var normalizedTitle=normalizeText(title);
  var duplicateTask=S.tasks.find(function(x){return x.id!==_editingTaskId&&normalizeText(x.title)===normalizedTitle;});
  if(duplicateTask){showToast('同じタイトルのタスクがすでにあります');document.getElementById('input-task-title').focus();return;}
  if(_editingTaskId){
    var t=S.tasks.find(function(x){return x.id===_editingTaskId;});if(!t)return;
    t.title=sanitize(title);t.load=load;t.type=type;
    if(type==='weekly'){t.weekDays=weekDays;t.deadline=null;t.unlockDate=null;if(!Array.isArray(t.doneHistory))t.doneHistory=[];if(!Array.isArray(t.skipHistory))t.skipHistory=[];}
    else{t.deadline=deadline||null;t.unlockDate=unlock||null;t.weekDays=[];}
    resetTodayPlan();
  }else{
    var task={id:generateId(),title:sanitize(title),load:load,type:type,createdAt:Date.now()};
    if(type==='weekly'){task.weekDays=weekDays;task.doneHistory=[];task.skipHistory=[];task.deadline=null;task.unlockDate=null;}
    else{task.deadline=deadline||null;task.unlockDate=unlock||null;task.weekDays=[];task.done=false;task.doneDate=null;}
    S.tasks.push(task);resetTodayPlan();
  }
  saveState();closeModal('modal-task');showToast(_editingTaskId?'更新しました':'タスクを追加しました');navigateTo('tasks');
}

// ─── DELETE / RESET ──────────────────────────────────────────────────────────
function openDeleteConfirm(id){_deletingTaskId=id;openModal('modal-delete-confirm');}
function executeDeleteTask(){closeModal('modal-delete-confirm');if(!_deletingTaskId)return;removeFromSnapshot(_deletingTaskId);S.tasks=S.tasks.filter(function(t){return t.id!==_deletingTaskId;});_deletingTaskId=null;saveState();showToast('削除しました');navigateTo('tasks');}
function openResetConfirm(){openModal('modal-confirm');}
function executeReset(){closeModal('modal-confirm');S=Object.assign({},STATE_DEFAULTS,{settings:Object.assign({},STATE_DEFAULTS.settings),learningHistory:{},tasks:[],learningAnalytics:{bySubject:{},byWeekday:{},compressed:{}},adaptiveHistory:{recommendedCapacity:null,missStreak:0,hitStreak:0,lastCapacityUpdateDate:null,dailyCompletion:{}},sessionHistory:[]});saveState();showToast('リセットしました');navigateTo('home');}

// ─── SETTINGS PAGE ───────────────────────────────────────────────────────────
// 円弧上の1点を極座標から算出する(中心100,100・半径r・角度deg、0度=真上)。
function dialPointOnCircle(cx,cy,r,deg){
  var rad=(deg-90)*Math.PI/180;
  return {x:cx+r*Math.cos(rad),y:cy+r*Math.sin(rad)};
}
// 270度スイープの円弧パス(SVG d属性)を生成する。startDeg/endDegは
// 「真上を0度」とした時計回りの角度。大円弧フラグはスイープが180度を
// 超える場合に1にする必要がある。
function dialArcPath(cx,cy,r,startDeg,endDeg){
  var s=dialPointOnCircle(cx,cy,r,startDeg),e=dialPointOnCircle(cx,cy,r,endDeg);
  var largeArc=(endDeg-startDeg)%360>180?1:0;
  return'M '+s.x+' '+s.y+' A '+r+' '+r+' 0 '+largeArc+' 1 '+e.x+' '+e.y;
}
// 宇宙船エンジンのスロットルつまみ風、画面幅の半分ほどある巨大な
// 円形メーター。平日/休日はタブで切り替え、常に1つのダイヤルだけを
// 大きく表示する(旧実装は2つの小さいダイヤルを並べていた)。
// 実際の値保持は隠しinput[type=range](#capacity-slider-*)が担う
// (saveCapacity()はそのまま無変更で動作する)。操作はSVG上のドラッグ
// (縦方向の移動量→値)を自前実装する。旧実装はネイティブの
// input[type=range]を正方形領域全体に重ねていたが、rangeは横長の
// 細い当たり判定しか持たないため円形ダイヤルの大部分が無反応になる
// バグがあった(「バーが動かせない」の直接原因)。
function bigEngineDial(capW,capH){
  return '<div class="tel-dial-tabs">'+
      '<button class="tdt-btn active" data-target="weekday" onclick="switchDialTab(\'weekday\')">平日</button>'+
      '<button class="tdt-btn" data-target="holiday" onclick="switchDialTab(\'holiday\')">休日</button>'+
    '</div>'+
    '<div class="tel-dial-big-wrap">'+
      dialSvg('weekday',1,30,capW)+
      dialSvg('holiday',0,30,capH,true)+
    '</div>'+
    '<input type="range" id="capacity-slider-weekday" min="1" max="30" step="1" value="'+capW+'" style="display:none">'+
    '<input type="range" id="capacity-slider-holiday" min="0" max="30" step="1" value="'+capH+'" style="display:none">';
}
function dialSvg(kind,min,max,value,hidden){
  var cx=100,cy=100,r=82,startA=-135,endA=135,sweep=endA-startA;
  var pct=Math.max(0,Math.min(1,(value-min)/(max-min)));
  var valA=startA+sweep*pct;
  var trackPath=dialArcPath(cx,cy,r,startA,endA);
  var arcPath=pct>0.002?dialArcPath(cx,cy,r,startA,valA):'';
  var ticks='';
  for(var i=0;i<=10;i++){
    var td=startA+sweep*(i/10);
    var major=(i%5===0);
    var p1=dialPointOnCircle(cx,cy,r+7,td),p2=dialPointOnCircle(cx,cy,major?r+17:r+12,td);
    ticks+='<line class="tel-dial-tick'+(major?' major':'')+'" x1="'+p1.x+'" y1="'+p1.y+'" x2="'+p2.x+'" y2="'+p2.y+'"/>';
  }
  return '<div class="tel-dial-big" id="dial-'+kind+'" data-kind="'+kind+'" data-min="'+min+'" data-max="'+max+'"'+
      (hidden?' style="display:none"':'')+
      ' onpointerdown="dialPointerDown(event,\''+kind+'\')">'+
    '<svg viewBox="0 0 200 200">'+
      '<path class="tel-dial-track" d="'+trackPath+'"/>'+
      (arcPath?'<path class="tel-dial-arc" d="'+arcPath+'"/>':'')+
      ticks+
    '</svg>'+
    '<div class="tel-dial-val"><span class="v-num" id="dial-val-'+kind+'">'+value+'</span><span class="v-unit">件 / 日</span></div>'+
  '</div>';
}
function switchDialTab(kind){
  document.querySelectorAll('.tdt-btn').forEach(function(b){b.classList.toggle('active',b.dataset.target===kind);});
  document.querySelectorAll('.tel-dial-big').forEach(function(d){d.style.display=(d.dataset.kind===kind?'':'none');});
}
// ドラッグ操作: 縦方向の移動量(上=増加・下=減少)をそのまま値の増減量に
// 変換する。円周をなぞる操作にしない理由は、画面の端でダイヤルの
// 一部が見切れていても、掴んだ位置に関わらず一貫した操作感を保てる
// ため(音響機器のノブと同じ操作モデル)。
var _dialDrag=null;
function dialPointerDown(e,kind){
  e.preventDefault();
  var el=document.getElementById('dial-'+kind);
  var input=document.getElementById('capacity-slider-'+(kind==='weekday'?'weekday':'holiday'));
  _dialDrag={kind:kind,el:el,input:input,startY:e.clientY,startVal:parseFloat(input.value),min:parseFloat(input.min),max:parseFloat(input.max)};
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove',dialPointerMove);
  el.addEventListener('pointerup',dialPointerUp);
  el.addEventListener('pointercancel',dialPointerUp);
}
function dialPointerMove(e){
  if(!_dialDrag)return;
  var dy=_dialDrag.startY-e.clientY; // 上へドラッグ=正
  // 画面高さの約40%のドラッグで最小→最大まで動く感度。
  var range=_dialDrag.max-_dialDrag.min;
  var sensitivity=range/(window.innerHeight*0.4);
  var raw=_dialDrag.startVal+dy*sensitivity;
  var val=Math.round(Math.max(_dialDrag.min,Math.min(_dialDrag.max,raw)));
  if(parseFloat(_dialDrag.input.value)!==val){
    _dialDrag.input.value=val;
    updateDialVisual(_dialDrag.kind,val);
  }
}
function dialPointerUp(e){
  if(!_dialDrag)return;
  _dialDrag.el.removeEventListener('pointermove',dialPointerMove);
  _dialDrag.el.removeEventListener('pointerup',dialPointerUp);
  _dialDrag.el.removeEventListener('pointercancel',dialPointerUp);
  _dialDrag=null;
}
// ダイヤルの進捗弧・数値表示を、値の変化に合わせてその場で再計算する
// (renderSettings全体の再描画を伴わない、ドラッグ中の軽量な見た目更新)。
function updateDialVisual(kind,value){
  var dial=document.getElementById('dial-'+kind);
  if(!dial)return;
  var min=parseFloat(dial.dataset.min),max=parseFloat(dial.dataset.max);
  var cx=100,cy=100,r=82,startA=-135,endA=135,sweep=endA-startA;
  var pct=Math.max(0,Math.min(1,(value-min)/(max-min)));
  var valA=startA+sweep*pct;
  var arcEl=dial.querySelector('.tel-dial-arc');
  if(pct>0.002){
    var path=dialArcPath(cx,cy,r,startA,valA);
    if(!arcEl){
      arcEl=document.createElementNS('http://www.w3.org/2000/svg','path');
      arcEl.setAttribute('class','tel-dial-arc');
      dial.querySelector('svg').insertBefore(arcEl,dial.querySelector('.tel-dial-tick'));
    }
    arcEl.setAttribute('d',path);
  }else if(arcEl){
    arcEl.remove();
  }
  var valEl=document.getElementById('dial-val-'+kind);
  if(valEl)valEl.textContent=value;
}

function renderSettings(){
  var capW=S.settings.capacityWeekday||CFG.DEFAULT_DAILY_CAPACITY,capH=S.settings.capacityHoliday||6;
  var oncePend=S.tasks.filter(function(t){return t.type!=='weekly'&&!t.done;}).length;
  var wklyCnt=S.tasks.filter(function(t){return t.type==='weekly';}).length;
  var overdue=S.tasks.filter(function(t){return t.type!=='weekly'&&!t.done&&t.deadline&&t.deadline<today();}).length;
  var levels=[0.5,1,1.5,2,3,4,5],descs=['〜15分','〜30分','〜45分','〜1時間','〜2時間','〜3時間','4時間超'];
  var guide='<div class="tel-guide"><div class="tel-guide-title">LOAD SCALE — 負荷値の目安</div>'+
    levels.map(function(l,i){var c=loadColor(l);return'<div class="tel-guide-row"><span class="badge" style="background:'+c+'18;color:'+c+';border-color:'+c+'30">'+loadLabel(l)+'</span><span class="tel-guide-desc">'+descs[i]+(l>=4?' ／ 1日1つまで':'')+'</span></div>';}).join('')+'</div>';
  return'<div class="page-wrap">'+
    '<div class="page-head">'+
      '<div class="page-eyebrow">SYSTEM CONSOLE</div>'+
      '<div class="page-title-main">設定</div>'+
    '</div>'+
    '<div class="panel"><div class="panel-head"><span class="panel-title">STATUS<span class="panel-title-jp">タスク概要</span></span></div>'+
      '<div class="tel-grid">'+
        '<div class="tel-cell"><span class="tel-num" id="st-pend" data-to="'+oncePend+'">0</span><span class="tel-lbl">未完了</span></div>'+
        '<div class="tel-cell"><span class="tel-num" id="st-overdue" style="'+(overdue>0?'color:var(--danger)':'')+'" data-to="'+overdue+'">0</span><span class="tel-lbl">期限超過</span></div>'+
        '<div class="tel-cell"><span class="tel-num" id="st-weekly" data-to="'+wklyCnt+'">0</span><span class="tel-lbl">週次</span></div>'+
      '</div></div>'+
    '<div class="panel"><div class="panel-head"><span class="panel-title">CAPACITY<span class="panel-title-jp">今日のキャパシティ</span></span></div>'+
      bigEngineDial(capW,capH)+
      '<button class="btn btn-primary btn-full" style="margin-top:6px" onclick="saveCapacity()">保存</button>'+
      guide+'</div>'+
    '<div class="panel"><div class="panel-head"><span class="panel-title">ABOUT<span class="panel-title-jp">恒星系について</span></span></div>'+
      '<p class="tel-note">「今日」ページの恒星系はタスクの締切と負荷から毎回組み立てられる架空の天体で、実在の太陽系配置ではありません。惑星の質感には<a href="https://www.solarsystemscope.com/textures/" target="_blank" rel="noopener">Solar System Scope</a>のテクスチャ(CC BY 4.0)を使用しています。</p>'+
    '</div>'+
    '<div class="panel"><div class="panel-head"><span class="panel-title">DATA<span class="panel-title-jp">データ管理</span></span></div>'+
      '<div class="tel-actions">'+
        '<button class="btn btn-secondary btn-full" onclick="exportData()">データをエクスポート</button>'+
        '<button class="btn btn-secondary btn-full" onclick="document.getElementById(\'import-input\').click()">データをインポート</button>'+
        '<input type="file" id="import-input" accept=".json" style="display:none" onchange="importData(event)">'+
        '<button class="btn btn-danger btn-full" onclick="openResetConfirm()">すべてのデータをリセット</button>'+
      '</div></div>'+
    '<div class="version-info">'+CFG.APP_NAME.toUpperCase()+' v'+CFG.APP_VERSION+'</div>'+
    '<div class="version-info sub">キャパシティと期限からタスクを自動配置するエンジン</div>'+
  '</div>';
}

/* ============================================================
   saveCapacity — キャパシティ保存（修正済み）
   ------------------------------------------------------------
   旧実装はユーザーがキャパシティ設定を変えても、内部の
   adaptiveHistory.recommendedCapacity（推奨キャパシティ）が
   古い値のまま据え置かれ、達成率予測やおすすめ順の計算がしばらく
   「変更前のキャパシティ」を基準にした古い判断のまま動き続ける、
   という挙動があった。設定変更の意図が即座に反映されるよう、
   数値が実際に変わった場合は推奨キャパシティとヒット/ミスの
   ストリークをその場でリセットし、新しい設定値から再出発させる。
   ============================================================ */
function saveCapacity(){
  var vw=parseInt(document.getElementById('capacity-slider-weekday').value,10);
  var vh=parseInt(document.getElementById('capacity-slider-holiday').value,10);
  var changed=false;
  if(vw>=1&&vw<=30&&vw!==S.settings.capacityWeekday){S.settings.capacityWeekday=vw;changed=true;}
  if(vh>=0&&vh<=30&&vh!==S.settings.capacityHoliday){S.settings.capacityHoliday=vh;changed=true;}
  if(changed){
    _ensureAdaptiveDefaults();
    S.adaptiveHistory.recommendedCapacity=Math.round((S.settings.capacityWeekday||CFG.DEFAULT_DAILY_CAPACITY)*1.075*10)/10;
    S.adaptiveHistory.missStreak=0;S.adaptiveHistory.hitStreak=0;
  }
  saveState();rebalanceSnapshot();showToast('キャパシティを保存しました');navigateTo('settings');
}


// ─── INIT ────────────────────────────────────────────────────────────────────
// 恒星系モジュール(type=module)は非同期に評価されるため、window.SolarSystemが
// まだ存在しないタイミングでinit()が走る可能性がある。onTaskComplete(天体を
// 完了させた時に実データを更新する)の配線は、モジュール側の準備が整うまで
// 短い間隔でリトライして確実に接続する(postRender側のtryInitと同じ方針)。
function wireSolarSystemCallbacks(){
  var tries=0;
  (function tryWire(){
    if(window.SolarSystem){
      window.SolarSystem.onTaskComplete=function(taskId,isWeekly){
        if(isWeekly)markWeeklyDoneToday(taskId);else toggleOnceDone(taskId);
        rebalanceWithKeep();
        // 恒星系はcompleteBody側で既に視覚的に消しているため、ここで
        // navigateTo('home')は呼ばない(呼ぶとシーンが作り直されて
        // パーティクル演出の途中で恒星系が再構築されてしまう)。
      };
      return;
    }
    if(++tries>200)return;
    setTimeout(tryWire,50);
  })();
}
// タスクフィールドモジュール(js/task-field.js、type=module)も同じ非同期
// 読込パターンを踏まえ、準備が整うまでリトライしてコールバックを配線する。
// onComplete: HUD Calloutの「達成」ボタン押下時。フィールド側は天体を
//   パーティクル演出で消すところまでを担当し、データ更新はここで行う。
// onEdit: 「編集」ボタン押下時。既存のタスク編集モーダルをそのまま開く。
function wireTaskFieldCallbacks(){
  var tries=0;
  (function tryWire(){
    if(window.TaskField){
      window.TaskField.onComplete=function(taskId,isWeekly){
        completePoolTask(taskId,isWeekly);
      };
      window.TaskField.onEdit=function(taskId){
        openEditTask(taskId);
      };
      return;
    }
    if(++tries>200)return;
    setTimeout(tryWire,50);
  })();
}
function init(){
  loadState();
  navigateTo('home');
  wireSolarSystemCallbacks();
  wireTaskFieldCallbacks();
  document.querySelectorAll('.modal-overlay').forEach(function(o){o.addEventListener('click',function(e){if(e.target===o)closeModal(o.id);});});
  window.addEventListener('offline',function(){document.getElementById('offline-badge').style.display='block';});
  window.addEventListener('online',function(){document.getElementById('offline-badge').style.display='none';});
  if(!navigator.onLine)document.getElementById('offline-badge').style.display='block';
}

init();
