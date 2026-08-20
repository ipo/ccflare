import type { BeginResult } from "@ccflare/oauth-flow";
import type { AccountProvider } from "@ccflare/types";
import type { AccountDisplay } from "@ccflare/ui";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useState } from "react";
import { useAppContext } from "../App.tsx";
import * as tuiCore from "../core";
import { C } from "../theme.ts";

interface AccountsScreenProps {
	refreshKey: number;
}

type Mode = "list" | "add" | "confirmRemove" | "waitingForCode";
type AddStep = "name" | "provider" | "apiKey";

export function AccountsScreen({ refreshKey }: AccountsScreenProps) {
	const { setInputActive } = useAppContext();
	const providerOptions = tuiCore.getAddAccountProviderOptions();
	const [mode, setMode] = useState<Mode>("list");
	const [accounts, setAccounts] = useState<AccountDisplay[]>([]);
	const [loading, setLoading] = useState(true);

	// List state
	const [listIdx, setListIdx] = useState(0);

	// Add account state
	const [newName, setNewName] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [addStep, setAddStep] = useState<AddStep>("name");
	const [authCode, setAuthCode] = useState("");
	const [oauthData, setOauthData] = useState<BeginResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Remove state
	const [accountToRemove, setAccountToRemove] = useState("");
	const [confirmInput, setConfirmInput] = useState("");

	// Sync inputActive with mode — blocks global shortcuts when in any input mode
	useEffect(() => {
		setInputActive(mode !== "list");
		return () => setInputActive(false);
	}, [mode, setInputActive]);

	const resetAdd = () => {
		setMode("list");
		setNewName("");
		setApiKey("");
		setAddStep("name");
		setAuthCode("");
		setOauthData(null);
		setError(null);
	};

	const loadAccounts = useCallback(async () => {
		try {
			const data = await tuiCore.getAccounts();
			setAccounts(data);
			setLoading(false);
		} catch {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadAccounts();
		const interval = setInterval(loadAccounts, 5000);
		return () => clearInterval(interval);
	}, [loadAccounts]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey triggers manual refresh
	useEffect(() => {
		loadAccounts();
	}, [refreshKey, loadAccounts]);

	const handlePrepareAdd = async (provider: AccountProvider) => {
		try {
			const prepared = await tuiCore.prepareAddAccount({
				name: newName,
				provider,
			});
			if (prepared.authMethod === "api_key") {
				setAddStep("apiKey");
			} else {
				setOauthData(prepared.flowData);
				setMode("waitingForCode");
			}
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to begin OAuth flow");
		}
	};

	const handleConfirmRemove = async () => {
		if (confirmInput !== accountToRemove) return;
		try {
			await tuiCore.removeAccount(accountToRemove);
			await loadAccounts();
			setMode("list");
			setAccountToRemove("");
			setConfirmInput("");
		} catch {
			// handled
		}
	};

	const handleTogglePause = async (account: AccountDisplay) => {
		try {
			if (account.paused) {
				await tuiCore.resumeAccount(account.name);
			} else {
				await tuiCore.pauseAccount(account.name);
			}
			await loadAccounts();
		} catch {
			// handled
		}
	};

	// Store selected provider index for submit
	const [selectedProviderIdx, setSelectedProviderIdx] = useState(0);

	useKeyboard((key) => {
		const isEnter = key.name === "return" || key.name === "enter";

		// Add mode — name step: <input> handles text, we handle Enter/Escape
		if (mode === "add" && addStep === "name") {
			if (isEnter && newName.length > 0) {
				setAddStep("provider");
			}
			if (key.name === "escape") {
				resetAdd();
			}
			return;
		}

		// Add mode — provider step: <select> handles nav+Enter via onSelect
		if (mode === "add" && addStep === "provider") {
			if (key.name === "escape") {
				setAddStep("name");
			}
			return;
		}

		// Add mode — API key step: <input> handles text
		if (mode === "add" && addStep === "apiKey") {
			if (isEnter && apiKey.length > 0) {
				const provider = providerOptions[selectedProviderIdx]?.value;
				if (provider) {
					tuiCore
						.submitAddAccount({
							name: newName,
							provider,
							apiKey,
							code: authCode,
							flowData: oauthData ?? undefined,
						})
						.then(() => {
							loadAccounts();
							resetAdd();
						})
						.catch((e) => {
							setError(
								e instanceof Error ? e.message : "Failed to add account",
							);
						});
				}
			}
			if (key.name === "escape") {
				resetAdd();
			}
			return;
		}

		// Waiting for OAuth code: <input> handles text
		if (mode === "waitingForCode") {
			if (isEnter && authCode.length > 0) {
				const provider = providerOptions[selectedProviderIdx]?.value;
				if (provider) {
					tuiCore
						.submitAddAccount({
							name: newName,
							provider,
							apiKey,
							code: authCode,
							flowData: oauthData ?? undefined,
						})
						.then(() => {
							loadAccounts();
							resetAdd();
						})
						.catch((e) => {
							setError(
								e instanceof Error ? e.message : "Failed to add account",
							);
						});
				}
			}
			if (key.name === "escape") {
				resetAdd();
			}
			return;
		}

		// Confirm remove: <input> handles text
		if (mode === "confirmRemove") {
			if (isEnter) {
				handleConfirmRemove();
			}
			if (key.name === "escape") {
				setMode("list");
				setAccountToRemove("");
				setConfirmInput("");
			}
			return;
		}

		// List mode
		if (key.name === "up" || key.name === "k") {
			setListIdx((i) => Math.max(0, i - 1));
		}
		if (key.name === "down" || key.name === "j") {
			setListIdx((i) => Math.min(accounts.length - 1, i + 1));
		}
		if (key.name === "a") {
			setMode("add");
			setAddStep("name");
		}
		if (key.name === "x" && accounts.length > 0) {
			const acc = accounts[listIdx];
			if (acc) {
				setAccountToRemove(acc.name);
				setConfirmInput("");
				setMode("confirmRemove");
			}
		}
		if (key.name === "p" && accounts.length > 0) {
			const acc = accounts[listIdx];
			if (acc) handleTogglePause(acc);
		}
	});

	if (loading) {
		return (
			<box padding={1}>
				<text fg={C.dim}>Loading accounts...</text>
			</box>
		);
	}

	// Add account flow
	if (mode === "add") {
		return (
			<box flexDirection="column" padding={1} gap={1}>
				<text fg={C.text}>
					<strong>Add Account</strong>
				</text>

				{addStep === "name" && (
					<box flexDirection="column" gap={1}>
						<text fg={C.dim}>Account name:</text>
						<input
							value={newName}
							onChange={setNewName}
							placeholder="my-account"
							focused
							width={30}
							backgroundColor={C.surface}
							textColor={C.text}
							cursorColor={C.accent}
						/>
						<text fg={C.muted}>Enter confirm · Esc cancel</text>
					</box>
				)}

				{addStep === "provider" && (
					<box flexDirection="column" gap={1}>
						<text fg={C.dim}>
							Account: <span fg={C.text}>{newName}</span>
						</text>
						<text fg={C.dim}>Select provider:</text>
						<select
							options={providerOptions.map((opt) => ({
								name: opt.label,
								description: opt.authMethod,
								value: opt.value,
							}))}
							onSelect={(index) => {
								setSelectedProviderIdx(index);
								const provider = providerOptions[index]?.value;
								if (provider) handlePrepareAdd(provider);
							}}
							focused
							height={6}
							showScrollIndicator
						/>
						<text fg={C.muted}>{"↑↓ navigate · Enter select · Esc back"}</text>
					</box>
				)}

				{addStep === "apiKey" && (
					<box flexDirection="column" gap={1}>
						<text fg={C.dim}>
							Provider:{" "}
							<span fg={C.text}>
								{providerOptions[selectedProviderIdx]?.label}
							</span>
						</text>
						<text fg={C.dim}>Enter API key:</text>
						<input
							value={apiKey}
							onChange={setApiKey}
							placeholder="sk-..."
							focused
							width={40}
							backgroundColor={C.surface}
							textColor={C.text}
							cursorColor={C.accent}
						/>
						<text fg={C.muted}>Enter submit · Esc cancel</text>
					</box>
				)}

				{error && <text fg={C.error}>{error}</text>}
			</box>
		);
	}

	// Waiting for OAuth code
	if (mode === "waitingForCode") {
		return (
			<box flexDirection="column" padding={1} gap={1}>
				<text fg={C.text}>
					<strong>Complete Authentication</strong>
				</text>
				<text fg={C.dim}>
					A browser window should have opened for authentication.
				</text>
				<text fg={C.dim}>After authorizing, enter the code below:</text>
				<input
					value={authCode}
					onChange={setAuthCode}
					placeholder="Authorization code"
					focused
					width={40}
					backgroundColor={C.surface}
					textColor={C.text}
					cursorColor={C.accent}
				/>
				{error && <text fg={C.error}>{error}</text>}
				<text fg={C.muted}>Enter submit · Esc cancel</text>
			</box>
		);
	}

	// Confirm remove
	if (mode === "confirmRemove") {
		return (
			<box flexDirection="column" padding={1} gap={1}>
				<text fg={C.error}>
					<strong>Confirm Account Removal</strong>
				</text>
				<text fg={C.dim}>
					{"You are about to remove account '"}
					{accountToRemove}
					{"'."}
				</text>
				<text fg={C.dim}>This action cannot be undone.</text>
				<box flexDirection="column" marginTop={1}>
					<text fg={C.dim}>
						Type <span fg={C.text}>{accountToRemove}</span> to confirm:
					</text>
					<input
						value={confirmInput}
						onChange={setConfirmInput}
						placeholder={accountToRemove}
						focused
						width={30}
						backgroundColor={C.surface}
						textColor={C.text}
						cursorColor={C.accent}
					/>
				</box>
				{confirmInput.length > 0 && confirmInput !== accountToRemove && (
					<text fg={C.error}>Account name does not match</text>
				)}
				<text fg={C.muted}>Enter confirm · Esc cancel</text>
			</box>
		);
	}

	// Account list
	return (
		<box flexDirection="column" padding={1} flexGrow={1}>
			<text fg={C.muted}>
				{"↑↓/jk navigate · "}
				<span fg={C.dim}>a</span>
				{" add · "}
				<span fg={C.dim}>p</span>
				{" pause/resume · "}
				<span fg={C.dim}>x</span>
				{" remove"}
			</text>

			{accounts.length === 0 ? (
				<box marginTop={1}>
					<text fg={C.muted}>
						{"No accounts configured. Press 'a' to add one."}
					</text>
				</box>
			) : (
				<box flexDirection="column" marginTop={1}>
					{accounts.map((acc, i) => {
						const selected = i === listIdx;
						const providerColor =
							acc.provider === "anthropic"
								? C.anthropic
								: acc.provider === "openai"
									? C.openai
									: acc.provider === "claude-code"
										? C.claudeCode
										: acc.provider === "grok"
											? C.grok
											: C.codex;

						return (
							<box
								key={acc.id}
								backgroundColor={selected ? C.surface : undefined}
								paddingX={1}
								paddingY={0}
							>
								<text fg={selected ? C.accent : C.text}>
									{selected ? "▸ " : "  "}
									<strong>{acc.name}</strong>
									<span fg={providerColor}> {acc.provider}</span>
									<span fg={C.muted}> · {acc.auth_method ?? "oauth"}</span>
									<span fg={C.dim}> · {acc.weightDisplay}</span>
									{acc.paused && <span fg={C.warning}> {"⏸ paused"}</span>}
									{acc.rateLimitStatus !== "ok" && (
										<span fg={C.warning}> {acc.rateLimitStatus}</span>
									)}
									<span fg={C.muted}>
										{" · "}
										{acc.requestCount.toString()} reqs
									</span>
								</text>
							</box>
						);
					})}
				</box>
			)}
		</box>
	);
}
