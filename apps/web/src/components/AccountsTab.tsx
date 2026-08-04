import type { AccountResponse } from "@ccflare/api";
import { AlertCircle, Plus } from "lucide-react";
import { useState } from "react";
import { useAccountsPageModel } from "../hooks/useAccountsPageModel";
import {
	AccountAddForm,
	AccountList,
	DeleteConfirmationDialog,
	RenameAccountDialog,
} from "./accounts";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";

export function AccountsTab() {
	const model = useAccountsPageModel();

	const [adding, setAdding] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<{
		show: boolean;
		accountId: string;
		accountName: string;
		confirmInput: string;
	}>({
		show: false,
		accountId: "",
		accountName: "",
		confirmInput: "",
	});
	const [renameDialog, setRenameDialog] = useState<{
		isOpen: boolean;
		account: AccountResponse | null;
	}>({
		isOpen: false,
		account: null,
	});

	const handleRemoveAccount = (account: AccountResponse) => {
		setConfirmDelete({
			show: true,
			accountId: account.id,
			accountName: account.name,
			confirmInput: "",
		});
	};

	const handleConfirmDelete = async () => {
		if (confirmDelete.confirmInput !== confirmDelete.accountName) {
			return;
		}
		await model.removeAccount(confirmDelete.accountId);
		setConfirmDelete({
			show: false,
			accountId: "",
			accountName: "",
			confirmInput: "",
		});
	};

	const handleConfirmRename = async (newName: string) => {
		if (!renameDialog.account) return;
		await model.renameAccount(renameDialog.account.id, newName);
		setRenameDialog({ isOpen: false, account: null });
	};

	if (model.loading) {
		return (
			<Card>
				<CardContent className="pt-6">
					<p className="text-muted-foreground">Loading accounts...</p>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			{model.error && (
				<Card className="border-destructive">
					<CardContent className="pt-6">
						<div className="flex items-center gap-2">
							<AlertCircle className="h-4 w-4 text-destructive" />
							<p className="text-destructive">{model.error}</p>
						</div>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<div>
							<CardTitle>Accounts</CardTitle>
							<CardDescription>
								Manage provider accounts and authentication settings
							</CardDescription>
						</div>
						{!adding && (
							<Button onClick={() => setAdding(true)} size="sm">
								<Plus className="mr-2 h-4 w-4" />
								Add Account
							</Button>
						)}
					</div>
				</CardHeader>
				<CardContent>
					{adding && (
						<AccountAddForm
							onCreateApiKeyAccount={async (params) => {
								await model.createApiKeyAccount(params);
								setAdding(false);
							}}
							onStartOAuth={model.startOAuth}
							onCompleteOAuth={model.completeOAuth}
							onGetSessionStatus={model.getSessionStatus}
							onOAuthCompleted={model.onOAuthCompleted}
							onCancel={() => {
								setAdding(false);
								model.clearError();
							}}
							onSuccess={() => {
								setAdding(false);
							}}
							onError={() => {}}
						/>
					)}

					<AccountList
						accounts={model.accounts}
						onPauseToggle={(account) => model.togglePause(account)}
						onResetRateLimit={model.resetRateLimit}
						resettingRateLimitAccountId={model.resettingRateLimitAccountId}
						onRemove={handleRemoveAccount}
						onRename={(account) => setRenameDialog({ isOpen: true, account })}
					/>
				</CardContent>
			</Card>

			{confirmDelete.show && (
				<DeleteConfirmationDialog
					accountName={confirmDelete.accountName}
					confirmInput={confirmDelete.confirmInput}
					onConfirmInputChange={(value) =>
						setConfirmDelete({
							...confirmDelete,
							confirmInput: value,
						})
					}
					onConfirm={handleConfirmDelete}
					onCancel={() => {
						setConfirmDelete({
							show: false,
							accountId: "",
							accountName: "",
							confirmInput: "",
						});
						model.clearError();
					}}
				/>
			)}

			{renameDialog.isOpen && renameDialog.account && (
				<RenameAccountDialog
					isOpen={renameDialog.isOpen}
					currentName={renameDialog.account.name}
					onClose={() => setRenameDialog({ isOpen: false, account: null })}
					onRename={handleConfirmRename}
					isLoading={model.isRenaming}
				/>
			)}
		</div>
	);
}
