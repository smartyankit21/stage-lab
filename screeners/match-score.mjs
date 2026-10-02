// Copied verbatim from Accumulation Lab (accumulation-lab-ankit.pages.dev/match-score.mjs, version match-price-15),
// read on 2 Oct 2026. Do not edit the calculation here; change it in Accumulation Lab first and copy it again.
const finite=Number.isFinite;
export const MATCH_MIN_MARKET_CAP_CRORE=1000;
const marketCapCrore=meta=>{const value=meta?.marketCapCrore??meta?.market_cap_crore??meta?.marketCap??meta?.market_cap??meta?.mcapCrore??meta?.mcap;const n=Number(value);return finite(n)?n:null;};
const ratio=(a,b)=>finite(a)&&finite(b)&&b!==0?a/b:null;
export function rounded(n,d=2){if(!finite(n))return null;const p=10**d,x=n*p,f=Math.floor(x),r=x-f;return (Math.abs(r-.5)<1e-10?(f%2===0?f:f+1):Math.round(x))/p;}
const sum=a=>a.every(finite)?a.reduce((s,v)=>s+v,0):null;
const rolling=(a,i,n)=>i>=n-1?sum(a.slice(i-n+1,i+1)):null;
export const COUNT_LIMITS=[3,3,3,2,2,2],SUM_LIMITS=[6,5.5,5.3,5.1,4.88,4.87];
export function matchStock(input,asof,meta=null){
const byDate=new Map();for(const row of input)if(row.date<=asof)byDate.set(row.date,row);
const rows=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));if(!rows.length)return null;
const dpt=rows.map(r=>ratio(r.delivery,r.trades)),ptv=rows.map(r=>ratio(r.volume,r.trades)),volume=rows.map(r=>r.volume);
const normal=a=>a.map((v,i)=>ratio(v,ratio(rolling(a,i,20),20)));
const d=normal(dpt),t=normal(ptv),v=normal(volume),above=d.map(x=>finite(x)&&x>=1?1:0);
const ge=(a,b)=>finite(a)&&finite(b)&&a>=b;
const counts=[],sums=[],blocks=[];
for(let b=0;b<6;b++){
const end=rows.length-1-b*5,start=end-4;
const count=rows.length<30?0:rolling(above,end,5),total=rows.length<30?0:rounded(rolling(d,end,5));
counts.push(count);sums.push(total);blocks.push({from:rows[start]?.date||null,to:rows[end]?.date||null,count,total});
}
const conditions=[...counts.map((value,i)=>({block:i+1,kind:'Days with PDV ratio ≥ 1',value,operator:'≥',threshold:COUNT_LIMITS[i],passed:ge(value,COUNT_LIMITS[i])})),...sums.map((value,i)=>({block:i+1,kind:'Sum of PDV ratios',value,operator:i<4?'≥':'≤',threshold:SUM_LIMITS[i],passed:finite(value)&&(i<4?value>=SUM_LIMITS[i]:value<=SUM_LIMITS[i])}))];
const score=conditions.filter(c=>c.passed).length,i=rows.length-1,latest=rows[i];
const count=(predicate,n)=>rolling(rows.map((_,j)=>predicate(j)?1:0),i,n);
const issues=[];if(rows.length<49)issues.push('Fewer than 49 observations: some PDV blocks lack a complete 20-session baseline. Missing comparisons follow the supplied script.');
if(latest.date!==asof)issues.push('Latest available observation is '+latest.date+'; the supplied script uses each stock’s latest available row.');
const dptSMA15=rows.map((_,j)=>ratio(rolling(dpt,j,15),15)),dptSMA45=rows.map((_,j)=>ratio(rolling(dpt,j,45),45));
const analysisBlocks=blocks.map((b,n)=>({count:b.count,total:b.total}));
const prior21=rows.slice(Math.max(0,i-20),i+1).map(r=>r.delivery).filter(finite);const oneDay=prior21.length>=2?ratio(latest.delivery,prior21.slice(0,-1).reduce((a,x)=>a+x,0)/(prior21.length-1)):null;
const analysisConditions=[
{name:'PDV blocks 11–20 sum',value:(sums[2]??0)+(sums[3]??0),operator:'≥',threshold:13,passed:finite(sums[2])&&finite(sums[3])&&sums[2]+sums[3]>=13},
{name:'PDV blocks 1–20 sum',value:sums.slice(0,4).every(finite)?sums.slice(0,4).reduce((a,x)=>a+x,0):null,operator:'≥',threshold:26,passed:sums.slice(0,4).every(finite)&&sums.slice(0,4).reduce((a,x)=>a+x,0)>=26},
{name:'Delivery vs prior 21-session mean',value:oneDay,operator:'≥',threshold:1.5,passed:finite(oneDay)&&oneDay>=1.5},
...[2,3,4,3].map((n,j)=>({name:`PDV ≥ 1 days, block ${j+1}`,value:counts[j],operator:'≥',threshold:n,passed:finite(counts[j])&&counts[j]>=n})),
...[true,true].map((_,j)=>({name:`PDV ≥ 1 days, block ${j+5}`,value:counts[j+4],operator:'≤',threshold:3,passed:finite(counts[j+4])&&counts[j+4]<=3})),
{name:'PDV ratio > 2, latest 40 sessions',value:count(j=>ge(d[j],2),40),operator:'≥',threshold:4,passed:finite(count(j=>ge(d[j],2),40))&&count(j=>ge(d[j],2),40)>=4},
...[5.8,5.9,5.3].map((n,j)=>({name:`PDV sum, block ${j+2}`,value:sums[j+1],operator:'≥',threshold:n,passed:finite(sums[j+1])&&sums[j+1]>=n})),
{name:'PDV sum, block 5',value:sums[4],operator:'≤',threshold:5.7,passed:finite(sums[4])&&sums[4]<=5.7},
{name:'PDV sum, block 6',value:sums[5],operator:'≤',threshold:7,passed:finite(sums[5])&&sums[5]<=7}
];
const analysisScore=analysisConditions.filter(c=>c.passed).length;
const dt=rows.map((_,j)=>ge(d[j],t[j])?1:0),dtv=rows.map((_,j)=>ge(d[j],t[j])&&ge(t[j],v[j])?1:0),d1=rows.map((_,j)=>ge(d[j],1)?1:0),d2=rows.map((_,j)=>ge(d[j],2)?1:0);
const futureMax=rows.map((_,j)=>Math.max(...rows.slice(j).map(q=>q.high??q.close).filter(finite))),future30=rows.map((_,j)=>rows.length-j>=30?Math.max(...rows.slice(j,j+30).map(q=>q.high??q.close).filter(finite)):null);
const analysisRows=rows.map((r,j)=>{const prev=r.prevClose??rows[j-1]?.close;const highs=rows.slice(Math.max(0,j-29),j+1).map(q=>q.close).filter(finite),prior=rows.slice(Math.max(0,j-30),j).map(q=>q.close).filter(finite);const blocksAt=[0,1,2,3,4,5].map(b=>{const end=j-b*5,start=end-4;return {count:end>=0?rolling(d1,end,5):null,total:end>=0?rounded(rolling(d,end,5)):null};});const priorD=rows.slice(Math.max(0,j-21),j).map(q=>q.delivery).filter(finite);return {date:r.date,open:r.open,high:r.high,low:r.low,rd:j>=60?ratio(r.delivery,ratio(rolling(rows.map(q=>q.delivery),j-1,60),60)):null,change:ratio((r.close-prev)*100,prev),close:r.close,closs:highs.length?ratio((r.close-Math.max(...highs))*100,Math.max(...highs)):null,closss:prior.length?ratio((r.close-Math.min(...prior))*100,Math.min(...prior)):null,ptv:ptv[j],turnover:ratio(r.turnover,1e7),volumeRatio:v[j],ptvRatio:t[j],pdv:dpt[j],pdvSMA15:dptSMA15[j],pdvSMA45:dptSMA45[j],pdvRatio:d[j],delivery:r.delivery,trades:r.trades,volume:r.volume,blocks:blocksAt,blockCounts:blocksAt.map(q=>q.count??'').join(' + '),blockSums:blocksAt.map(q=>q.total??'').join(' + '),dGreaterT:rolling(dt,j,10),dGreaterTGreaterV:rolling(dtv,j,21),dGreaterTGreaterV2:j>=21?rolling(dtv,j-21,21):null,dAtLeast1:rolling(d1,j,40),dAtLeast2:rolling(d2,j,40),oneDay:priorD.length?ratio(r.delivery,priorD.reduce((a,x)=>a+x,0)/priorD.length):null,return:ratio((futureMax[j]-r.close)*100,r.close),return30:finite(future30[j])?ratio((future30[j]-r.close)*100,r.close):null};});
const cap=marketCapCrore(meta);
return {symbol:latest.symbol,asof,status:score>=9?'candidate':'none',score,analysisScore,meta:meta?{...meta,marketCapCrore:cap}:meta,latest,observations:rows.length,issues,blocks,conditions,analysisConditions,analysisRows,metrics:{marketCapCrore:cap,change:ratio((latest.close-latest.prevClose)*100,latest.prevClose),turnover:ratio(latest.turnover,1e7),volumeRatio:v[i],ptvRatio:t[i],pdvRatio:d[i],dGreaterT:count(j=>ge(d[j],t[j]),10),dGreaterTGreaterV:count(j=>ge(d[j],t[j])&&ge(t[j],v[j]),21),dAtLeast1:count(j=>ge(d[j],1),40),dAtLeast2:count(j=>ge(d[j],2),40)},patterns:[],firstSeen:null};
}
export function scanMatch(rows,asof,master=[]){
const groups=new Map(),names=new Map(master.map(m=>[m.symbol,m]));for(const r of rows){if(!groups.has(r.symbol))groups.set(r.symbol,[]);groups.get(r.symbol).push(r);}
return [...groups].map(([symbol,r])=>matchStock(r,asof,names.get(symbol))).filter(Boolean).filter(r=>r.metrics.marketCapCrore===null||r.metrics.marketCapCrore>=MATCH_MIN_MARKET_CAP_CRORE).sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));
}
export function matchExport(r){const m=r.metrics;return {SYMBOL:r.symbol,DATE:r.latest.date,MARKET_CAP_CRORE:r.metrics.marketCapCrore??'','Change (%)':rounded(m.change,1),turnover:rounded(m.turnover,1),VOLUME_RATIO:rounded(m.volumeRatio,1),'PTV / SMA(20)':rounded(m.ptvRatio,1),'PDV/SMA(20)':rounded(m.pdvRatio,1),'30 days':r.blocks.map(b=>b.count??'nan').join(' + '),PDV:r.blocks.map(b=>b.total??'nan').join(' + '),'D > T':m.dGreaterT,'D > T > V':m.dGreaterTGreaterV,'D >= 1':m.dAtLeast1,'PDV/SMA(20) >= 2 (40 days)':m.dAtLeast2,Match_Score:r.score};}
