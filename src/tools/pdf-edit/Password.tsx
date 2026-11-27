import { useState } from "react";
import { Button, Note } from "../../lib/ui.tsx";
import s from "./PdfEdit.module.css";

export function Password({
	file,
	previous,
	open,
	label = "PDF password",
}: {
	file: File;
	previous: boolean;
	open: (file: File, password: string) => void;
	label?: string;
}) {
	const [password, setPassword] = useState("");
	return (
		<form
			className={s.password}
			onSubmit={(e) => {
				e.preventDefault();
				open(file, password);
			}}
		>
			{previous && <Note tone="danger">Incorrect PDF password. Try again.</Note>}
			<label>
				{label}{" "}
				<input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
			</label>
			<Button type="submit" icon="lock">
				Unlock PDF
			</Button>
		</form>
	);
}
