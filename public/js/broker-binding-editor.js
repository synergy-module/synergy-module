const FIELDS = {
  account: {number:'Account identifier',cash:'Available cash',equity:'Total equity',dailyPnl:'Daily profit / loss',weeklyPnl:'Weekly profit / loss',isAgentic:'Dedicated Agentic account',observedAt:'Account observation time',marketOpen:'Regular market session open',ordersClear:'Pending orders cleared'},
  positions: {symbol:'Stock symbol',quantity:'Shares held',averageCost:'Average cost',value:'Current holding value',openedAt:'Position opened at',holdingId:'Holding identifier'},
  markets: {symbol:'Stock symbol',bid:'Current bid',ask:'Current ask',quoteAt:'Quote timestamp',tradable:'Tradable status',isLeveraged:'Leveraged product flag',isInverse:'Inverse product flag',avgVolume:'Average trading volume',marketCap:'Market capitalization',closes:'Closing-price series',volume:'Current volume',high52:'52-week high',low52:'52-week low',earningsDays:'Days to earnings',earningsKnown:'Earnings date known',lossSaleDays:'Days since a loss sale',lossHistoryComplete:'Complete loss-sale history'},
  orders: {requestId:'Request identifier',status:'Order status',filledQuantity:'Filled shares',averagePrice:'Average fill price',symbol:'Stock symbol',side:'Buy or sell',number:'Account identifier'},
  preview: {valid:'Explicit approval flag',warnings:'Warnings list',cost:'Total projected cost'},
};
const KINDS = {account:'Account balances',positions:'Current holdings',markets:'Market prices & risk evidence',orders:'Order history',preview:'Order preview approval'};
export function initializeBrokerBindingEditor(root, { changed = () => {}, feedback = () => {} } = {}) {
  const document = root.ownerDocument, target = root.querySelector('[data-rh-binding-editor]'), raw = root.querySelector('[data-rh-bindings]');
  let bindings = [], catalog = [], disposed = false;
  const listeners = [], on = (node,event,handler) => { node.addEventListener(event,handler); listeners.push(() => node.removeEventListener(event,handler)); };
  const el = (tag,text,className) => { const node = document.createElement(tag); if(text !== undefined) node.textContent = text; if(className) node.className = className; return node; };
  const field = (label,name,value,attributes={}) => { const wrapper = el('label',label,'field'), input = el('input'); input.name = name; input.value = value ?? ''; for(const [key,item] of Object.entries(attributes)) input.setAttribute(key,item); wrapper.append(input); return wrapper; };
  function read() {
    return [...target.querySelectorAll('[data-binding-row]')].map(card => {
      const kind = card.querySelector('[data-binding-kind]').value, tool = card.querySelector('[data-binding-tool]').value, args = {}, fields = {};
      for(const input of card.querySelectorAll('[data-binding-argument]')) {
        if(input.value === '') continue; const type = input.dataset.argumentType; let value = input.value;
        if(!['{account}','{symbols}'].includes(value)) {
          if(['number','integer'].includes(type)) { value = Number(value); if(!Number.isFinite(value) || type === 'integer' && !Number.isInteger(value)) throw new Error(`Enter a number for ${input.dataset.bindingArgument}.`); }
          else if(type === 'boolean') value = value === 'true';
          else if(['array','object'].includes(type)) { try { value = JSON.parse(value); } catch { throw new Error(`Enter valid JSON for the advanced argument ${input.dataset.bindingArgument}, or use {symbols}.`); } }
        }
        args[input.dataset.bindingArgument] = value;
      }
      for(const input of card.querySelectorAll('[data-binding-field]')) { const column = card.querySelectorAll('[data-binding-column]')[Number(input.dataset.fieldIndex)].value.trim(); if(input.value.trim() || column || input.dataset.rootMapping === 'true') fields[input.dataset.bindingField] = column ? {path:input.value.trim(),column} : input.value.trim(); }
      return {kind,tool,arguments:args,root:card.querySelector('[data-binding-root]').value.trim(),fields};
    });
  }
  function sync() { try { bindings = read(); raw.value = JSON.stringify(bindings,null,2); } catch { /* Validation messages appear on Save. */ } changed(); }
  function render(next = bindings) {
    if(disposed) return; bindings = structuredClone(next); target.replaceChildren();
    if(!bindings.length) target.append(el('p','No data sources mapped yet. Sync broker tools, then add the sources for balances, holdings, market evidence and order history.','poly-model-note'));
    bindings.forEach((binding,index) => {
      const card = el('section',undefined,'rh-binding-card'); card.dataset.bindingRow = String(index); const heading = el('div',undefined,'poly-record-head'); heading.append(el('h3',KINDS[binding.kind] || 'Data source'));
      const remove = el('button','Remove source','text-action'); remove.type='button'; remove.addEventListener('click',()=>{ try { bindings=read(); bindings.splice(index,1); render();sync(); }catch(error){ feedback(error.message); } }); heading.append(remove);card.append(heading);
      const grid = el('div',undefined,'poly-settings-grid'), kindLabel=el('label','What does this source provide?','field'), kind=el('select');kind.dataset.bindingKind='';
      for(const [id,label] of Object.entries(KINDS)){const option=el('option',label);option.value=id;kind.append(option);}kind.value=binding.kind;kindLabel.append(kind);
      const toolLabel=el('label','Connected broker tool','field'),tool=el('select');tool.dataset.bindingTool=''; const candidates=catalog.filter(item=>binding.kind==='preview'?item.name==='review_equity_order':/^(get_|search$|run_scan$)/.test(item.name));
      const first=el('option','Choose a discovered read tool');first.value='';tool.append(first);
      if(binding.tool&&!candidates.some(item=>item.name===binding.tool)) candidates.unshift({name:binding.tool,title:`${binding.tool} (saved mapping)`});
      for(const item of candidates){const option=el('option',item.title || item.name.replaceAll('_',' '));option.value=item.name;tool.append(option);}tool.value=binding.tool || '';toolLabel.append(tool);grid.append(kindLabel,toolLabel);
      const rootField=field('Location of the returned record or list','binding-root',binding.root,{placeholder:'/data/items',maxlength:'200'});rootField.querySelector('input').dataset.bindingRoot='';grid.append(rootField);card.append(grid,el('p','Use a slash path from the broker response, such as /data/accounts. Leave the record location blank when the response itself is the record.','poly-model-note'));
      const schema=catalog.find(item=>item.name===binding.tool)?.inputSchema?.properties ?? {}, names=new Set([...Object.keys(schema),...Object.keys(binding.arguments ?? {})]);
      if(names.size){const args=el('details');args.open=true;args.append(el('summary','Tool inputs'));const inputs=el('div',undefined,'poly-settings-grid');
        for(const name of names){const value=binding.arguments?.[name],type=schema[name]?.type || (Array.isArray(value)?'array':typeof value==='object'?'object':typeof value==='number'?'number':'string');let wrapper,input;
          if(type==='boolean'){wrapper=el('label',schema[name]?.description || name.replaceAll('_',' '),'field');input=el('select');for(const [v,l]of [['','Not supplied'],['true','Yes'],['false','No']]){const option=el('option',l);option.value=v;input.append(option);}input.value=value===undefined?'':String(value);wrapper.append(input);}
          else{wrapper=field(schema[name]?.description || name.replaceAll('_',' '),`argument-${name}`,typeof value==='object'?JSON.stringify(value):value,{placeholder:/account/i.test(name)?'{account}':/symbol/i.test(name)?'{symbols}':'Value',maxlength:'2000'});input=wrapper.querySelector('input');}
          input.dataset.bindingArgument=name;input.dataset.argumentType=type;inputs.append(wrapper);
        }args.append(inputs,el('p','Use {account} for the account identifier above and {symbols} for your selected stock symbols.','poly-model-note'));card.append(args);
      }
      const mappings=el('details');mappings.open=true;mappings.append(el('summary','Match the financial fields'));const fieldsGrid=el('div',undefined,'rh-mapping-fields');
      Object.entries(FIELDS[binding.kind] ?? {}).forEach(([name,label],fieldIndex)=>{const group=el('div',undefined,'rh-mapping-row'),value=binding.fields?.[name],pathField=field(label,`map-${name}`,typeof value==='object'?value.path:value,{placeholder:`/${name}`,maxlength:'200'}),input=pathField.querySelector('input');input.dataset.bindingField=name;if(value==='')input.dataset.rootMapping='true';input.dataset.fieldIndex=String(fieldIndex);const column=field('List item field (optional)',`column-${name}`,typeof value==='object'?value.column:'',{placeholder:'/close',maxlength:'200'});column.querySelector('input').dataset.bindingColumn=name;group.append(pathField,column);fieldsGrid.append(group);});mappings.append(fieldsGrid);card.append(mappings);target.append(card);
      kind.addEventListener('change',()=>{try{const values=read();values[index]={kind:kind.value,tool:'',arguments:{},root:'',fields:{}};render(values);sync();}catch(error){feedback(error.message);}});
      tool.addEventListener('change',()=>{try{const values=read();values[index].arguments={};render(values);sync();}catch(error){feedback(error.message);}});
    });
  }
  on(target,'input',sync);on(target,'change',sync);
  on(root.querySelector('[data-rh-binding-add]'),'click',()=>{try{bindings=read();if(bindings.length>=12)throw new Error('Use up to twelve broker data sources.');bindings.push({kind:'account',tool:'',arguments:{},root:'',fields:{}});render();sync();}catch(error){feedback(error.message);}});
  on(root.querySelector('[data-rh-binding-import]'),'click',()=>{try{const value=JSON.parse(raw.value);if(!Array.isArray(value)||value.length>12||value.some(row=>!row||!FIELDS[row.kind]||!row.fields||!row.arguments))throw new Error('Import a list of up to twelve supported broker mappings.');render(value);changed();feedback('Mapping loaded into the editor. Save and verify it before running.');}catch(error){feedback(error.message);}});
  return {render,read,setCatalog(tools){catalog=Array.isArray(tools)?tools:[];try{render(read());}catch{/* Preserve incomplete edits. */}},dispose(){disposed=true;listeners.forEach(remove=>remove());}};
}
