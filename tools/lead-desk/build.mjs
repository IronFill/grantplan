import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const out = path.resolve(process.argv[2] || 'outputs/lead-desk');
await fs.mkdir(out, {recursive:true});
const destination=path.join(out,'GrantPlan_Учёт_обращений_и_продаж.xlsx');
if(!process.argv.includes('--replace-template')){
 try {await fs.access(destination);throw new Error('File exists. Use a new output folder; --replace-template only replaces a known blank template.');}
 catch(e){if(e.code!=='ENOENT')throw e;}
}
const wb = Workbook.create();
const summary = wb.worksheets.add('Сводка');
const leads = wb.worksheets.add('Обращения');
const cash = wb.worksheets.add('Платежи');
const time = wb.worksheets.add('Время');
const FIRST=8, LAST=157;
const rr=(sheet,col)=>`'${sheet}'!$${col}$${FIRST}:$${col}$${LAST}`;
const serial=(iso)=>Math.round((new Date(iso+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000);
const start=serial('2026-10-01'), end=serial('2026-10-16');
const money='#,##0.00';
const style={ink:'#172D30',accent:'#E7A54A',input:'#FFF2D6',calc:'#EDF1F2',muted:'#596A70',error:'#FCE2DF'};
function val(s,cell,value){s.getRange(cell).values=[[value]];}
function fx(s,cell,formula){s.getRange(cell).formulas=[[formula]];}
function line(s,row,label){val(s,`A${row}`,label);s.getRange(`A${row}:B${row}`).format.fill='#E5ECEA';s.getRange(`A${row}`).format.font.bold=true;}
function setup(s,title,headers,widths,note){
 const last=String.fromCharCode(64+headers.length);
 s.showGridLines=false;
 s.getRange(`A1:${last}${LAST}`).format.font={name:'Arial',size:11,color:style.ink};
 s.getRange(`A1:${last}${LAST}`).format.verticalAlignment='center';
 val(s,'A2',title);s.getRange('A2').format.font={name:'Arial',size:16,bold:true,color:style.ink};
 val(s,'A4',note);s.getRange('A4').format.font={name:'Arial',size:11,color:style.muted};
 s.getRange(`A7:${last}7`).values=[headers];
 s.getRange(`A7:${last}7`).format={fill:style.ink,font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},wrapText:true,rowHeight:42,horizontalAlignment:'center',verticalAlignment:'center'};
 widths.forEach((w,i)=>s.getRange(`${String.fromCharCode(65+i)}1:${String.fromCharCode(65+i)}${LAST}`).format.columnWidth=w);
 s.getRange(`A8:${last}${LAST}`).format.rowHeight=30;
 s.freezePanes.freezeRows(7);s.freezePanes.freezeColumns(1);
 s.tables.add(`A7:${last}${LAST}`,true,'Table'+s.name.replace(/[^A-Za-z]/g,'')+headers.length).showFilterButton=true;
}
setup(leads,'GrantPlan: журнал обращений',
 ['ID обращения','Первый контакт','Источник','REAL / TEST','Подходит?','Стадия','Следующий шаг','Дата шага','Ответственный','Встреча проведена','Проверка записи','Действие','Ошибок'],
 [18,17,18,15,18,18,34,17,20,36,26,30,12],
 'Одна строка на обращение. ID постоянный; контакты храните отдельно. 150 строк.');
setup(cash,'Подтверждённые денежные операции',
 ['ID операции','ID обращения','Дата операции','Вид операции','Сумма, грн','Подтверждение','Примечание','Проверка записи','В учёте','Источник','Ошибок'],
 [18,18,17,20,19,23,34,30,13,18,12],
 'Одна строка на платёж или возврат. Сумма положительная; вид задаёт направление.');
setup(time,'Фактически затраченное время',
 ['ID записи','ID обращения','Дата работы','Работа','Часы','REAL / TEST','Примечание','Проверка записи','В учёте','Ошибок'],
 [18,18,17,23,15,15,38,30,13,12],
 'Продажи и исполнение привязаны к обращению. Маркетинг и управление могут быть без ID.');
summary.showGridLines=false;summary.tabColor=style.ink;
summary.getRange('A1:J36').format.font={name:'Arial',size:11,color:style.ink};
summary.getRange('A1:J36').format.rowHeight=26;
summary.getRange('A1:A36').format.columnWidth=47;
summary.getRange('B1:B36').format.columnWidth=19;
summary.getRange('C1:C36').format.columnWidth=3;
summary.getRange('D1:D36').format.columnWidth=24;
summary.getRange('E1:E36').format.columnWidth=18;
summary.getRange('F1:F36').format.columnWidth=3;
summary.getRange('G1:G36').format.columnWidth=18;
summary.getRange('H1:J36').format.columnWidth=19;
val(summary,'A2','GrantPlan: обращения, деньги и время');summary.getRange('A2').format.font={name:'Arial',size:16,bold:true,color:style.ink};
val(summary,'A4','Начало периода');val(summary,'B4',start);val(summary,'D4','Конец периода');val(summary,'E4',end);
for(const cell of ['B4','E4']){summary.getRange(cell).format.fill=style.input;summary.getRange(cell).setNumberFormat('dd.mm.yyyy');}
val(summary,'A6','По внесённым записям. Пустой журнал не доказывает отсутствие продаж.');summary.getRange('A6').format.font.color=style.muted;
line(summary,7,'Обращения');
['Новые REAL за период','Из них квалифицированы','Открытые REAL сейчас','Просроченные следующие шаги','Нет шага, даты или ответственного'].forEach((v,i)=>val(summary,`A${8+i}`,v));
val(summary,'A13','Проведённые встречи новой когорты');
line(summary,14,'Деньги за период, грн');
['Подтверждённые поступления','Подтверждённые возвраты','Поступления минус возвраты'].forEach((v,i)=>val(summary,`A${15+i}`,v));
val(summary,'A19','Суммы не являются прибылью: расходы и налоги здесь не вычтены.');summary.getRange('A19').format.font.color=style.muted;
line(summary,21,'Фактические часы за период');
['Продажи','Исполнение','Маркетинг','Управление'].forEach((v,i)=>val(summary,`A${22+i}`,v));
val(summary,'A26','Всего часов');fx(summary,'B26','=SUM(B22:B25)');
line(summary,28,'Записи, требующие проверки');
['Обращения с ошибкой ID/даты/типа','Денежные операции с ошибкой','Записи времени с ошибкой'].forEach((v,i)=>val(summary,`A${29+i}`,v));
val(summary,'A33','Ввод: жёлтые поля. Серые поля рассчитываются. TEST исключён из сводки.');
val(summary,'A34','Даты в сводке меняйте вручную. Стадии и открытые обращения показывают текущее состояние.');
val(summary,'A35','Заполняйте до строки 157. Для расширения нужны новые формулы и границы сводки.');
summary.getRange('A33:A35').format.font.color=style.muted;
summary.getRange('G7:J7').values=[['Источник','Новые REAL','Поступления, грн','Возвраты, грн']];
summary.getRange('G7:J7').format={fill:style.ink,font:{color:'#FFFFFF',bold:true},wrapText:true,rowHeight:42};
const sources=['Google','YouTube','Facebook','Партнёр','Неизвестно'];
summary.getRange('G8:G12').values=sources.map(x=>[x]);
for(const [s,lastInput,lastCalc] of [[leads,'J','M'],[cash,'G','K'],[time,'G','J']]){
 s.getRange(`A8:${lastInput}${LAST}`).format.fill=style.input;
 s.getRange(`${String.fromCharCode(lastInput.charCodeAt(0)+1)}8:${lastCalc}${LAST}`).format.fill=style.calc;
 s.getRange(`H8:H${LAST}`).format.wrapText=true;
}
const list=(s,col,values)=>s.getRange(`${col}8:${col}${LAST}`).dataValidation={rule:{type:'list',values}};
list(leads,'C',sources);list(leads,'D',['REAL','TEST']);list(leads,'E',['Так','Ні','Не з’ясовано']);
list(leads,'F',['Нове','Розмова','Пропозиція','Робота','Завершено','Втрачено']);
list(cash,'D',['Надходження','Повернення']);list(cash,'F',['Підтверджено','Очікується']);
list(time,'D',['Продаж','Виконання','Маркетинг','Управління']);list(time,'F',['REAL','TEST']);
for(const [s,cols] of [[leads,['B','H','J']],[cash,['C']],[time,['C']]])for(const col of cols)s.getRange(`${col}8:${col}${LAST}`).setNumberFormat('yyyy-mm-dd');
cash.getRange(`E8:E${LAST}`).setNumberFormat(money);time.getRange(`E8:E${LAST}`).setNumberFormat('0.00');
for(const s of [cash,time])s.getRange(`E8:E${LAST}`).dataValidation={rule:{type:'decimal',operator:'greaterThanOrEqual',formula1:0}};
const lid=rr('Обращения','A'),ltype=rr('Обращения','D'),lcheck=rr('Обращения','K');
for(let r=FIRST;r<=LAST;r++){
 fx(leads,`K${r}`,`=IF(COUNTA(A${r}:J${r})=0,"",IF(A${r}="","Нет ID",IF(COUNTIFS($A$8:$A$157,A${r})<>1,"Повтор ID",IF(OR(NOT(ISNUMBER(B${r})),B${r}<=0),"Проверьте дату",IF(AND(J${r}<>"",OR(NOT(ISNUMBER(J${r})),J${r}<B${r})),"Проверьте дату встречи",IF(OR(D${r}="REAL",D${r}="TEST"),"OK","Укажите REAL/TEST"))))))`);
 fx(leads,`L${r}`,`=IF(OR(K${r}<>"OK",D${r}<>"REAL"),"",IF(OR(F${r}="Завершено",F${r}="Втрачено"),"Закрыто",IF(F${r}="","Укажите стадию",IF(G${r}="","Укажите следующий шаг",IF(NOT(ISNUMBER(H${r})),"Укажите дату шага",IF(I${r}="","Укажите ответственного",IF(H${r}<'Сводка'!$E$4,"Просрочено",IF(H${r}='Сводка'!$E$4,"На дату отчёта","Запланировано"))))))))`);
 const linked=`COUNTIFS(${lid},B${r},${lcheck},"OK")=1`;
 fx(cash,`H${r}`,`=IF(COUNTA(A${r}:G${r})=0,"",IF(A${r}="","Нет ID операции",IF(COUNTIFS($A$8:$A$157,A${r})<>1,"Повтор операции",IF(NOT(${linked}),"Проверьте ID обращения",IF(OR(NOT(ISNUMBER(C${r})),C${r}<=0),"Проверьте дату",IF(OR(NOT(ISNUMBER(E${r})),E${r}<0),"Проверьте сумму",IF(AND(OR(D${r}="Надходження",D${r}="Повернення"),OR(F${r}="Підтверджено",F${r}="Очікується")),"OK","Укажите вид и подтверждение")))))))`);
 fx(cash,`I${r}`,`=IF(H${r}<>"OK",0,IF(AND(F${r}="Підтверджено",COUNTIFS(${lid},B${r},${ltype},"REAL")=1),1,0))`);
 fx(cash,`J${r}`,`=IF(H${r}<>"OK","",IF(COUNTIFS('Сводка'!$G$8:$G$12,INDEX('Обращения'!$C$8:$C$157,MATCH(B${r},${lid},0)))=1,INDEX('Обращения'!$C$8:$C$157,MATCH(B${r},${lid},0)),"Неизвестно"))`);
 fx(time,`H${r}`,`=IF(COUNTA(A${r}:G${r})=0,"",IF(A${r}="","Нет ID записи",IF(COUNTIFS($A$8:$A$157,A${r})<>1,"Повтор записи",IF(OR(NOT(ISNUMBER(C${r})),C${r}<=0),"Проверьте дату",IF(OR(NOT(ISNUMBER(E${r})),E${r}<0),"Проверьте часы",IF(NOT(OR(F${r}="REAL",F${r}="TEST")),"Укажите REAL/TEST",IF(NOT(OR(D${r}="Продаж",D${r}="Виконання",D${r}="Маркетинг",D${r}="Управління")),"Укажите работу",IF(AND(B${r}="",OR(D${r}="Маркетинг",D${r}="Управління")),"OK",IF(${linked},"OK","Проверьте ID обращения")))))))))`);
 fx(time,`I${r}`,`=IF(H${r}<>"OK",0,IF(F${r}<>"REAL",0,IF(B${r}="",1,IF(COUNTIFS(${lid},B${r},${ltype},"REAL")=1,1,0))))`);
}
const period=(datecol)=>`${datecol},">="&$B$4,${datecol},"<"&$E$4+1`;
const guard=(formula)=>`=IF(AND(ISNUMBER($B$4),ISNUMBER($E$4),$B$4<=$E$4),${formula},"н.д.")`;
const leadPeriod=period(rr('Обращения','B'));
fx(summary,'B8',guard(`COUNTIFS(${lcheck},"OK",${ltype},"REAL",${leadPeriod})`));
fx(summary,'B9',guard(`COUNTIFS(${lcheck},"OK",${ltype},"REAL",${leadPeriod},${rr('Обращения','E')},"Так")`));
fx(summary,'B13',guard(`COUNTIFS(${lcheck},"OK",${ltype},"REAL",${leadPeriod},${rr('Обращения','J')},">0",${rr('Обращения','J')},"<"&$E$4+1)`));
fx(summary,'B10',`=COUNTIFS(${lcheck},"OK",${ltype},"REAL",${rr('Обращения','F')},"<>Завершено",${rr('Обращения','F')},"<>Втрачено")`);
fx(summary,'B11',guard(`COUNTIFS(${rr('Обращения','L')},"Просрочено")`));
fx(summary,'B12',`=COUNTIFS(${rr('Обращения','L')},"Укажите*")`);
const cashFormula=(kind,source)=>`SUMIFS(${rr('Платежи','E')},${rr('Платежи','I')},1,${rr('Платежи','D')},"${kind}",${period(rr('Платежи','C'))}${source?`,${rr('Платежи','J')},${source}`:''})`;
fx(summary,'B15',guard(cashFormula('Надходження')));fx(summary,'B16',guard(cashFormula('Повернення')));
fx(summary,'B17',guard('B15-B16'));
fx(summary,'B26',guard('SUM(B22:B25)'));
for(const [i,kind] of ['Продаж','Виконання','Маркетинг','Управління'].entries())fx(summary,`B${22+i}`,guard(`SUMIFS(${rr('Время','E')},${rr('Время','I')},1,${rr('Время','D')},"${kind}",${period(rr('Время','C'))})`));
for(const [i,s,check,errors,lastInput] of [[0,leads,'K','M','J'],[1,cash,'H','K','G'],[2,time,'H','J','G']]){
 for(let r=FIRST;r<=LAST;r++)fx(s,`${errors}${r}`,`=IF(COUNTA(A${r}:${lastInput}${r})=0,0,IF(${check}${r}="OK",0,1))`);
 fx(summary,`B${29+i}`,`=SUM(${rr(s.name,errors)})`);
}
for(let r=8;r<=12;r++){
 const src=r===12?`SUM(COUNTIFS(${lcheck},"OK",${ltype},"REAL",${leadPeriod},${rr('Обращения','C')},G${r}),COUNTIFS(${lcheck},"OK",${ltype},"REAL",${leadPeriod},${rr('Обращения','C')},""))`:`COUNTIFS(${lcheck},"OK",${ltype},"REAL",${leadPeriod},${rr('Обращения','C')},G${r})`;
 fx(summary,`H${r}`,guard(src));fx(summary,`I${r}`,guard(cashFormula('Надходження',`G${r}`)));fx(summary,`J${r}`,guard(cashFormula('Повернення',`G${r}`)));
}
// Blank source is counted as unknown using total minus named sources, avoiding
// the engine's known COUNTIFS empty-string limitation.
fx(summary,'H12',guard('B8-SUM(H8:H11)'));
summary.getRange('B15:B17').setNumberFormat(money);summary.getRange('I8:J12').setNumberFormat(money);summary.getRange('B22:B26').setNumberFormat('0.00');
summary.getRange('B29:B31').conditionalFormats.add('cellIs',{operator:'greaterThan',formula:0,format:{fill:style.error,font:{color:'#9C2A20',bold:true}}});
for(const [s,c] of [[leads,'K'],[cash,'H'],[time,'H']])s.getRange(`${c}8:${c}${LAST}`).conditionalFormats.addCustom(`AND(${c}8<>"",${c}8<>"OK")`,{fill:style.error,font:{color:'#9C2A20',bold:true}});
leads.getRange(`L8:L${LAST}`).conditionalFormats.add('containsText',{text:'Просрочено',format:{fill:style.error,font:{color:'#9C2A20',bold:true}}});

// Test changes in this in-memory workbook, then clear all synthetic rows before
// delivery. No customer data and no network operations.
const put=(s,row,values)=>s.getRangeByIndexes(row-1,0,1,values.length).values=[values];
put(leads,8,['GP-0001',serial('2026-10-01'),'Facebook','REAL','Так','Пропозиція','Погодити наступний крок',serial('2026-10-15'),'Власник',serial('2026-10-15')]);
put(leads,9,['TEST-1',serial('2026-10-03'),'YouTube','TEST','Так','Нове']);
put(leads,10,['GP-0002',serial('2026-09-30'),'Google','REAL','Ні','Втрачено']);
put(cash,8,['PAY-1','GP-0001',serial('2026-10-16'),'Надходження',3000,'Підтверджено']);
put(cash,9,['PAY-2','GP-0001',serial('2026-10-16'),'Повернення',500,'Підтверджено']);
put(cash,10,['PAY-T','TEST-1',serial('2026-10-16'),'Надходження',9999,'Підтверджено']);
put(cash,11,['PAY-P','GP-0001',serial('2026-10-16'),'Надходження',2000,'Очікується']);
put(cash,12,['PAY-F','GP-0001',serial('2026-10-17'),'Надходження',700,'Підтверджено']);
put(time,8,['TIME-1','GP-0001',serial('2026-10-16'),'Продаж',1.5,'REAL']);
put(time,9,['TIME-T','TEST-1',serial('2026-10-16'),'Виконання',99,'REAL']);
put(time,10,['TIME-M',null,serial('2026-10-16'),'Маркетинг',2,'REAL']);
wb.recalculate();
const checks=[];
function eq(cell,want,label){const got=summary.getRange(cell).values[0][0];assert.equal(got,want,`${label}: ${cell}=${got}`);checks.push({label,cell,got,want});}
eq('B8',1,'New lead cohort excludes TEST and prior period');eq('B9',1,'Qualified cohort');eq('B11',1,'Overdue step');eq('B15',3000,'Cash excludes pending/test/future');eq('B16',500,'Refund separate');eq('B17',2500,'Net cash, not profit');eq('B22',1.5,'Sales hours');eq('B23',0,'TEST-linked work excluded');eq('B24',2,'Marketing hours without lead');eq('H10',1,'Facebook lead count');eq('I10',3000,'Facebook cash attribution');
eq('B13',1,'A completed meeting belongs to the new lead cohort');
val(leads,'J8',serial('2026-10-17'));wb.recalculate();eq('B13',0,'Future meeting not counted as completed by report end');val(leads,'J8',serial('2026-10-15'));
leads.getRange('G8:I8').clear({applyTo:'contents'});wb.recalculate();assert.equal(leads.getRange('L8').values[0][0],'Укажите следующий шаг');
val(leads,'G8','Погодити зустріч');wb.recalculate();assert.equal(leads.getRange('L8').values[0][0],'Укажите дату шага');
val(leads,'H8',serial('2026-10-15'));wb.recalculate();assert.equal(leads.getRange('L8').values[0][0],'Укажите ответственного');val(leads,'I8','Власник');
summary.getRange('E4').clear({applyTo:'contents'});wb.recalculate();eq('B15','н.д.','Missing period end is not zero cash');eq('B26','н.д.','Missing period end is not zero hours');val(summary,'E4',end);
val(cash,'E8',0);wb.recalculate();eq('B15',0,'A valid confirmed zero remains zero');
cash.getRange('E8').clear({applyTo:'contents'});wb.recalculate();eq('B30',1,'Missing amount is visible');
val(cash,'E8',3000);put(leads,11,['GP-0001',serial('2026-10-02'),'Facebook','REAL']);wb.recalculate();eq('B29',2,'Both duplicated lead IDs flagged');eq('B15',0,'Ambiguous lead cannot receive cash attribution');
leads.getRange('A11:J11').clear({applyTo:'contents'});cash.getRange('B8').values=[['MISSING']];wb.recalculate();eq('B30',1,'Unmatched payment ID visible');
val(cash,'B8','GP-0001');val(summary,'E4',serial('2026-10-17'));wb.recalculate();eq('B15',3700,'Period boundary includes next day after control change');
val(summary,'E4',end);leads.getRange('C8').clear({applyTo:'contents'});wb.recalculate();eq('H12',1,'Blank source stays unknown');eq('I12',3000,'Blank-source cash stays unknown');
val(leads,'C8','typo-source');wb.recalculate();eq('H12',1,'Unrecognized source stays unknown');eq('I12',3000,'Unrecognized source cash reconciles');
for(const [s,lastInput] of [[leads,'J'],[cash,'G'],[time,'G']])s.getRange(`A8:${lastInput}${LAST}`).clear({applyTo:'contents'});
val(summary,'B4',new Date('2026-10-01T00:00:00Z'));val(summary,'E4',new Date('2026-10-16T00:00:00Z'));
summary.getRange('B4').setNumberFormat('yyyy-mm-dd');summary.getRange('E4').setNumberFormat('yyyy-mm-dd');
wb.recalculate();eq('B8',0,'Delivered workbook has no real or synthetic records');eq('B15',0,'Blank cash ledger');eq('B29',0,'Blank records do not create errors');eq('B30',0,'Blank payments do not create errors');eq('B31',0,'Blank work log does not create errors');
await fs.writeFile(path.join(out,'verification.json'),JSON.stringify({engine:'@oai/artifact-tool',checks,excel_native_recalculation_verified:false,delivered_records:0},null,2));
const errors=await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',options:{useRegex:true,maxResults:30},summary:'Formula error scan'});
await fs.writeFile(path.join(out,'formula-scan.ndjson'),errors.ndjson);
for(const [s,range,name] of [[summary,'A1:J35','summary'],[leads,'A1:F14','leads-input'],[leads,'G7:L14','leads-actions'],[cash,'A1:J14','cash'],[time,'A1:I14','time']]){
 const p=await wb.render({sheetName:s.name,range,scale:1.5,format:'png'});
 await fs.writeFile(path.join(out,name+'.png'),new Uint8Array(await p.arrayBuffer()));
}
await (await SpreadsheetFile.exportXlsx(wb)).save(destination);
console.log(JSON.stringify({output:out,checks:checks.length,workbook:'GrantPlan_Учёт_обращений_и_продаж.xlsx'}));
