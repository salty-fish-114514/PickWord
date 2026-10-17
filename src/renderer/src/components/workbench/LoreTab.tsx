import { useMemo, useState } from "react";

import { AliasField, CardShell, FieldArea, ListToolbar } from "./shared";
import { Icon } from "../Icon";
import { countMentions, newLoreEntry } from "../../lib/materials";
import type { LoreCategory, LoreEntry, Materials } from "../../lib/types";
import { LORE_CATEGORY_LABEL } from "../../../../shared/materials";

interface LoreTabProps {
  materials: Materials;
  onChange: (next: Materials) => void;
  text: string;
  selectedText: string;
}

const CATEGORIES: LoreCategory[] = ["place", "org", "item", "other"];

/** 「设定」：地点 / 组织 / 物品 / 其他 四类条目，结构比角色卡简单：名字 + 别名 + 一段说明。 */
export function LoreTab({ materials, onChange, text, selectedText }: LoreTabProps) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<LoreCategory | "all">("all");

  const entries = materials.lore;
  const mentions = useMemo(() => countMentions(entries, text), [entries, text]);

  const filtered = useMemo(() => {
    const term = query.trim();
    return entries.filter(
      (entry) =>
        (filter === "all" || entry.category === filter) &&
        (!term || entry.name.includes(term) || entry.aliases.some((alias) => alias.includes(term))),
    );
  }, [entries, query, filter]);

  function update(id: string, patch: Partial<LoreEntry>) {
    onChange({ ...materials, lore: entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) });
  }

  function remove(id: string) {
    onChange({ ...materials, lore: entries.filter((entry) => entry.id !== id) });
    if (openId === id) setOpenId(null);
  }

  function create() {
    const entry = newLoreEntry(selectedText.trim().slice(0, 20), filter === "all" ? "other" : filter);
    onChange({ ...materials, lore: [...entries, entry] });
    setOpenId(entry.id);
    setQuery("");
  }

  return (
    <>
      <ListToolbar query={query} onQuery={setQuery} placeholder="搜索名字或别名" onCreate={create} createLabel="新建" />

      <div className="scope-switch" role="tablist" aria-label="设定分类">
        <button type="button" role="tab" aria-selected={filter === "all"} className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>
          全部
        </button>
        {CATEGORIES.map((category) => (
          <button key={category} type="button" role="tab" aria-selected={filter === category} className={filter === category ? "is-active" : ""} onClick={() => setFilter(category)}>
            {LORE_CATEGORY_LABEL[category]}
          </button>
        ))}
      </div>

      {entries.length === 0 && (
        <div className="chapter-empty">
          <p>还没有设定条目。</p>
          <span>地名、门派、法宝、专有名词……名字出现在送入模型的正文里时，说明会自动随提示词注入。</span>
        </div>
      )}

      {CATEGORIES.map((category) => {
        const inCategory = filtered.filter((entry) => entry.category === category);
        if (inCategory.length === 0) return null;
        return (
          <section className="material-group" key={category}>
            <div className="material-group-head">
              <span>{LORE_CATEGORY_LABEL[category]}</span>
              <span>{inCategory.length}</span>
            </div>
            {inCategory.map((entry) => (
              <CardShell
                key={entry.id}
                open={openId === entry.id}
                onToggle={() => setOpenId(openId === entry.id ? null : entry.id)}
                title={entry.name}
                meta={`${mentions.get(entry.id) ?? 0} 次`}
                injected={entry.inject}
                onInject={(next) => update(entry.id, { inject: next })}
              >
                <label className="card-field card-field-inline">
                  <span className="card-field-label">名字</span>
                  <input className="text-field card-field-input" type="text" value={entry.name} placeholder="名称" onChange={(event) => update(entry.id, { name: event.target.value })} />
                </label>
                <AliasField aliases={entry.aliases} onChange={(aliases) => update(entry.id, { aliases })} />
                <div className="card-row">
                  <span className="card-field-label">分类</span>
                  <div className="scope-switch is-compact" role="radiogroup" aria-label="设定分类">
                    {CATEGORIES.map((c) => (
                      <button key={c} type="button" role="radio" aria-checked={entry.category === c} className={entry.category === c ? "is-active" : ""} onClick={() => update(entry.id, { category: c })}>
                        {LORE_CATEGORY_LABEL[c]}
                      </button>
                    ))}
                  </div>
                </div>
                <FieldArea label="说明" value={entry.text} placeholder="它是什么、在哪里、有什么规矩……" onChange={(value) => update(entry.id, { text: value })} />
                <div className="card-actions">
                  <span />
                  <button className="link-button is-danger" type="button" onClick={() => remove(entry.id)}>
                    <Icon name="trash" size={13} />
                    删除条目
                  </button>
                </div>
              </CardShell>
            ))}
          </section>
        );
      })}
    </>
  );
}
