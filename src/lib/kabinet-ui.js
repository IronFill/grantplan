// Побудова DOM для повної карточки. Увесь текст вставляється через textContent, а не innerHTML:
// навіть якщо в базі опиниться розмітка, вона не виконається.

export function renderSections(doc, container, sections) {
  container.replaceChildren();
  for (const section of sections) {
    const block = doc.createElement('div');
    block.className = 'rounded-card bg-surface border border-border p-6';
    const h = doc.createElement('h3');
    h.className = 'text-lg font-display font-semibold';
    h.textContent = section.title;
    block.append(h);

    if (section.type === 'text' || section.type === 'notice') {
      const p = doc.createElement('p');
      p.className = 'mt-2 text-muted leading-relaxed';
      p.textContent = section.text;
      block.append(p);
    } else if (section.type === 'list' || section.type === 'steps') {
      const l = doc.createElement(section.type === 'steps' ? 'ol' : 'ul');
      l.className = 'mt-3 grid gap-2 leading-relaxed ' + (section.type === 'steps' ? 'list-decimal pl-5' : 'list-disc pl-5');
      for (const item of section.items) {
        const li = doc.createElement('li');
        li.textContent = item;
        l.append(li);
      }
      block.append(l);
    } else if (section.type === 'links') {
      const l = doc.createElement('ul');
      l.className = 'mt-3 grid gap-2';
      for (const item of section.items) {
        const li = doc.createElement('li');
        const a = doc.createElement('a');
        a.href = item.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'text-accent underline underline-offset-4';
        a.textContent = item.title;
        li.append(a);
        if (item.checkedLabel) {
          const span = doc.createElement('span');
          span.className = 'text-sm text-muted';
          span.textContent = ` (перевірено ${item.checkedLabel})`;
          li.append(span);
        }
        l.append(li);
      }
      block.append(l);
    }
    container.append(block);
  }
}
