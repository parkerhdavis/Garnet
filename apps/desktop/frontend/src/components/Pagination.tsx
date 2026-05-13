// SPDX-License-Identifier: AGPL-3.0-or-later
type Props = {
	page: number;
	pageSize: number;
	total: number;
	onPage: (page: number) => void;
};

export function Pagination({ page, pageSize, total, onPage }: Props) {
	if (total <= pageSize) return null;
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const pageStart = page * pageSize + 1;
	const pageEnd = Math.min(total, (page + 1) * pageSize);
	return (
		<div className="flex items-center justify-between px-6 py-3 bg-base-100 border-t border-base-300">
			<div className="text-sm text-base-content/60 tabular-nums">
				{pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of{" "}
				{total.toLocaleString()}
			</div>
			<div className="join">
				<button
					type="button"
					className="btn btn-sm join-item"
					disabled={page === 0}
					onClick={() => onPage(page - 1)}
				>
					Prev
				</button>
				<button type="button" className="btn btn-sm join-item pointer-events-none">
					{page + 1} / {totalPages}
				</button>
				<button
					type="button"
					className="btn btn-sm join-item"
					disabled={page + 1 >= totalPages}
					onClick={() => onPage(page + 1)}
				>
					Next
				</button>
			</div>
		</div>
	);
}
