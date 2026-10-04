/**
 * 仅追加（append-only）事件存储：JSONL 落盘 + 内存索引。
 * 事件不可变——回滚策略通过新增指针事件实现，绝不改写或删除历史事件。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

let clock = () => new Date().toISOString();
export function setClock(fn) {
  clock = fn;
}

export class EventStore {
  constructor(file = null) {
    this.file = file;
    /** @type {Array<object>} */
    this.events = [];
    /** @type {Map<string, number>} 聚合当前版本号 */
    this.aggregateVersions = new Map();
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) this._ingest(JSON.parse(line));
      }
    }
  }

  _ingest(e) {
    this.events.push(e);
    this.aggregateVersions.set(e.aggregate_id, e.version);
  }

  /**
   * 追加领域事件。
   * @param {{event_type:string, aggregate_type:string, aggregate_id:string, summary:string, payload?:object}} rec
   */
  append({ event_type, aggregate_type, aggregate_id, summary, payload = {} }) {
    const version = (this.aggregateVersions.get(aggregate_id) ?? 0) + 1;
    const event = {
      event_id: randomUUID(),
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at: clock(),
      version,
      summary,
      ...payload,
    };
    this._ingest(event);
    if (this.file) {
      if (!existsSync(dirname(this.file))) mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(event) + "\n");
    }
    return event;
  }

  forAggregate(aggregateId) {
    return this.events.filter((e) => e.aggregate_id === aggregateId);
  }

  all() {
    return [...this.events];
  }
}
