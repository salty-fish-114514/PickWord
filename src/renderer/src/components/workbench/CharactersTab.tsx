import { useMemo, useState } from "react";

import { AliasField, CardShell, FieldArea, ListToolbar } from "./shared";
import { Icon } from "../Icon";
import type { Chapter, ChapterIndex } from "../../lib/chapters";
import { countMentions, extractCandidateNames, newCharacterCard, type ExtractedName } from "../../lib/materials";
import type { CharacterCard, CharacterGroup, Materials } from "../../lib/types";
import { CHARACTER_GROUP_LABEL } from "../../../../shared/materials";

interface CharactersTabProps {
  materials: Materials;
  onChange: (next: Materials) => void;
  text: string;
  chapterIndex: ChapterIndex;
  currentChapter: Chapter;
  selectedText: string;
}

const GROUPS: CharacterGroup[] = ["main", "minor"];

/**
 * 「角色」：卡片列表（主要 / 次要分组）+ 搜索 + 新建 + 从正文提取候选名字。
 * 卡片字段：背景 / 性格 / 外观 三个半固定字段，加「+ 字段」自定义。
 */
export function CharactersTab({ materials, onChange, text, chapterIndex, currentChapter, selectedText }: CharactersTabProps) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<ExtractedName[] | null>(null);
  const [scope, setScope] = useState<"chapter" | "all">(chapterIndex.hasMarks ? "chapter" : "all");

  const cards = materials.characters;
  const scopeText = scope === "chapter" && chapterIndex.hasMarks ? text.slice(currentChapter.bodyStart, currentChapter.end) : text;
  const mentions = useMemo(() => countMentions(cards, scopeText), [cards, scopeText]);

  const filtered = useMemo(() => {
    const term = query.trim();
    if (!term) return cards;
    return cards.filter((card) => card.name.includes(term) || card.aliases.some((alias) => alias.includes(term)));
  }, [cards, query]);

  function update(id: string, patch: Partial<CharacterCard>) {
    onChange({ ...materials, characters: cards.map((card) => (card.id === id ? { ...card, ...patch } : card)) });
  }

  function remove(id: string) {
    onChange({ ...materials, characters: cards.filter((card) => card.id !== id) });
    if (openId === id) setOpenId(null);
  }

  function create(name: string) {
    const card = newCharacterCard(name);
    onChange({ ...materials, characters: [...cards, card] });
    setOpenId(card.id);
    setQuery("");
  }

  function runExtract() {
    const known = [...cards.flatMap((card) => [card.name, ...card.aliases]), ...materials.lore.flatMap((l) => [l.name, ...l.aliases])];
    setExtracted(extractCandidateNames(text, known));
  }

  return (
    <>
      <ListToolbar
        query={query}
        onQuery={setQuery}
        placeholder="搜索名字或别名"
        onCreate={() => create(selectedText.trim().slice(0, 20) || "")}
        createLabel="新建"
        extra={
          <button className="quiet-button list-extract" type="button" onClick={runExtract} title="统计正文里反复出现的 2~4 字片段，作为建卡候选（纯本地，不调模型）">
            <Icon name="sparkle" size={14} />
            <span>提取</span>
          </button>
        }
      />

      {extracted && (
        <section className="extract-box">
          <div className="context-block-head">
            <span className="context-block-title">正文里的高频片段</span>
            <button className="link-button" type="button" onClick={() => setExtracted(null)}>
              收起
            </button>
          </div>
          {extracted.length === 0 ? (
            <p className="context-hint">没有找到新的候选（已建卡的名字不会重复列出）。</p>
          ) : (
            <div className="extract-chips">
              {extracted.map((item) => (
                <button key={item.text} className="extract-chip" type="button" title={`出现 ${item.count} 次 · 点击建卡`} onClick={() => create(item.text)}>
                  {item.text}
                  <span>{item.count}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {cards.length > 0 && chapterIndex.hasMarks && (
        <div className="scope-switch" role="tablist" aria-label="提及统计范围">
          <button type="button" role="tab" aria-selected={scope === "chapter"} className={scope === "chapter" ? "is-active" : ""} onClick={() => setScope("chapter")}>
            本章提及
          </button>
          <button type="button" role="tab" aria-selected={scope === "all"} className={scope === "all" ? "is-active" : ""} onClick={() => setScope("all")}>
            全卷提及
          </button>
        </div>
      )}

      {cards.length === 0 && !extracted && (
        <div className="chapter-empty">
          <p>还没有角色卡。</p>
          <span>建卡后，名字一出现在送入模型的正文里，卡片内容就会自动随提示词注入；也可以先用「提取」找出正文里反复出现的名字。</span>
        </div>
      )}

      {GROUPS.map((group) => {
        const inGroup = filtered.filter((card) => card.group === group);
        if (inGroup.length === 0) return null;
        return (
          <section className="material-group" key={group}>
            <div className="material-group-head">
              <span>{CHARACTER_GROUP_LABEL[group]}</span>
              <span>{inGroup.length}</span>
            </div>
            {inGroup.map((card) => (
              <CardShell
                key={card.id}
                open={openId === card.id}
                onToggle={() => setOpenId(openId === card.id ? null : card.id)}
                title={card.name}
                meta={`${mentions.get(card.id) ?? 0} 次`}
                injected={card.inject}
                onInject={(next) => update(card.id, { inject: next })}
              >
                <label className="card-field card-field-inline">
                  <span className="card-field-label">名字</span>
                  <input className="text-field card-field-input" type="text" value={card.name} placeholder="角色名" onChange={(event) => update(card.id, { name: event.target.value })} />
                </label>
                <AliasField aliases={card.aliases} onChange={(aliases) => update(card.id, { aliases })} />
                <div className="card-row">
                  <span className="card-field-label">分组</span>
                  <div className="scope-switch is-compact" role="radiogroup" aria-label="角色分组">
                    {GROUPS.map((g) => (
                      <button key={g} type="button" role="radio" aria-checked={card.group === g} className={card.group === g ? "is-active" : ""} onClick={() => update(card.id, { group: g })}>
                        {CHARACTER_GROUP_LABEL[g].slice(0, 2)}
                      </button>
                    ))}
                  </div>
                </div>
                <FieldArea label="背景" value={card.background} placeholder="出身、经历、与他人的关系……" onChange={(value) => update(card.id, { background: value })} />
                <FieldArea label="性格" value={card.personality} placeholder="说话方式、口头禅、行事风格……" onChange={(value) => update(card.id, { personality: value })} />
                <FieldArea label="外观" value={card.appearance} placeholder="年龄、相貌、穿着、标志性特征……" onChange={(value) => update(card.id, { appearance: value })} />
                {card.extra.map((field, index) => (
                  <div className="card-extra" key={index}>
                    <input
                      className="text-field card-field-input card-extra-label"
                      type="text"
                      value={field.label}
                      placeholder="字段名"
                      aria-label="自定义字段名"
                      onChange={(event) => update(card.id, { extra: card.extra.map((f, i) => (i === index ? { ...f, label: event.target.value } : f)) })}
                    />
                    <FieldArea
                      label=""
                      value={field.text}
                      placeholder="内容"
                      onChange={(value) => update(card.id, { extra: card.extra.map((f, i) => (i === index ? { ...f, text: value } : f)) })}
                      onRemove={() => update(card.id, { extra: card.extra.filter((_, i) => i !== index) })}
                    />
                  </div>
                ))}
                <div className="card-actions">
                  <button className="link-button" type="button" onClick={() => update(card.id, { extra: [...card.extra, { label: "", text: "" }] })}>
                    <Icon name="plus" size={13} />
                    字段
                  </button>
                  <button className="link-button is-danger" type="button" onClick={() => remove(card.id)}>
                    <Icon name="trash" size={13} />
                    删除卡片
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
