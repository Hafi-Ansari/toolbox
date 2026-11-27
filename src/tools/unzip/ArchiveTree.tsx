import { type CSSProperties, useState } from "react";
import { formatBytes } from "../../lib/format.ts";
import { Icon } from "../../lib/Icon.tsx";
import { Button } from "../../lib/ui.tsx";
import type { Entry } from "./engine/listing.ts";
import s from "./Unzip.module.css";

interface FileNode {
	id: string;
	name: string;
	index: number;
	entry: Entry;
}

interface DirectoryNode {
	id: string;
	name: string;
	children: TreeNode[];
	files: number[];
}

type TreeNode = DirectoryNode | FileNode;

export function makeTree(entries: Entry[], paths: string[]) {
	const root: DirectoryNode = { id: "", name: "", children: [], files: [] };
	const directories = new Map<string, DirectoryNode>([["", root]]);
	for (const [index, entry] of entries.entries()) {
		if (entry.special) continue;
		const parts = paths[index].split("/");
		const name = parts.pop() ?? "unnamed";
		if (entry.folder) parts.push(name);
		let parent = root;
		if (!entry.folder) root.files.push(index);
		for (const name of parts) {
			const id = parent.id ? `${parent.id}/${name}` : name;
			let node = directories.get(id);
			if (!node) {
				node = { id, name, children: [], files: [] };
				directories.set(id, node);
				parent.children.push(node);
			}
			if (!entry.folder) node.files.push(index);
			parent = node;
		}
		if (!entry.folder) parent.children.push({ id: paths[index], name, index, entry });
	}
	for (const node of directories.values()) {
		node.children.sort((a, b) => Number("children" in b) - Number("children" in a) || a.name.localeCompare(b.name));
	}
	return root.children;
}

interface TreeControls {
	selected: Set<number>;
	previewed: number | undefined;
	busy: boolean;
	select(files: number[], checked: boolean): void;
	preview(index: number): void;
	save(index: number): void;
}

function Directory({ node, depth, controls }: { node: DirectoryNode; depth: number; controls: TreeControls }) {
	const [expanded, setExpanded] = useState(false);
	const count = node.files.filter((id) => controls.selected.has(id)).length;
	return (
		<li>
			<div className={s.row} style={{ "--indent": Math.min(depth, 5) } as CSSProperties}>
				<input
					type="checkbox"
					aria-label={`Select folder ${node.name}`}
					ref={(input) => {
						if (input) input.indeterminate = count > 0 && count < node.files.length;
					}}
					checked={count > 0 && count === node.files.length}
					disabled={controls.busy || node.files.length === 0}
					onChange={(event) => controls.select(node.files, event.currentTarget.checked)}
				/>
				<button type="button" className={s.name} aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
					<span className={expanded ? s.arrowDown : s.arrow} aria-hidden="true" />
					<Icon name="folder" size={15} />
					<span title={node.name}>{node.name}</span>
				</button>
			</div>
			{expanded && <Rows nodes={node.children} depth={depth + 1} controls={controls} />}
		</li>
	);
}

function FileRow({ node, depth, controls }: { node: FileNode; depth: number; controls: TreeControls }) {
	return (
		<li className={s.row} style={{ "--indent": Math.min(depth, 5) } as CSSProperties}>
			<input
				type="checkbox"
				aria-label={`Select ${node.name}`}
				checked={controls.selected.has(node.index)}
				disabled={controls.busy}
				onChange={(event) => controls.select([node.index], event.currentTarget.checked)}
			/>
			<button
				type="button"
				className={s.name}
				aria-pressed={controls.previewed === node.index}
				disabled={controls.busy}
				onClick={() => controls.preview(node.index)}
			>
				<Icon name="text" size={15} />
				<span title={node.name}>{node.name}</span>
			</button>
			<span className={s.details}>{formatBytes(node.entry.size)}</span>
			<span className={`${s.details} ${s.date}`}>{node.entry.modified?.slice(0, 10) || "—"}</span>
			<Button
				icon="download"
				variant="ghost"
				className={s.iconButton}
				disabled={controls.busy}
				aria-label={`Save ${node.name}`}
				onClick={() => controls.save(node.index)}
			/>
		</li>
	);
}

function Rows({ nodes, depth, controls }: { nodes: TreeNode[]; depth: number; controls: TreeControls }) {
	const [limit, setLimit] = useState(500);
	return (
		<>
			<ul className={s.rows}>
				{nodes
					.slice(0, limit)
					.map((node) =>
						"children" in node ? (
							<Directory key={node.id} node={node} depth={depth} controls={controls} />
						) : (
							<FileRow key={node.id} node={node} depth={depth} controls={controls} />
						),
					)}
			</ul>
			{limit < nodes.length && (
				<Button className={s.more} variant="ghost" onClick={() => setLimit((count) => count + 500)}>
					Show more
				</Button>
			)}
		</>
	);
}

export function ArchiveTree({ nodes, controls }: { nodes: TreeNode[]; controls: TreeControls }) {
	return (
		<div className={s.tree}>
			<div className={`${s.row} ${s.columns}`} aria-hidden="true">
				<span />
				<span>Name</span>
				<span>Size</span>
				<span className={s.date}>Modified</span>
			</div>
			{nodes.length ? (
				<Rows nodes={nodes} depth={0} controls={controls} />
			) : (
				<p className={s.empty}>This archive has no files or folders to extract.</p>
			)}
		</div>
	);
}
