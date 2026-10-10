import { Request, Response } from 'express';
import { ArchivedEmailService } from '../../services/ArchivedEmailService';
import { UserService } from '../../services/UserService';
import { checkDeletionEnabled } from '../../helpers/deletionGuard';

export class ArchivedEmailController {
	private userService = new UserService();
	public getArchivedEmails = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { ingestionSourceId } = req.params;
			const page = parseInt(req.query.page as string, 10) || 1;
			const limit = parseInt(req.query.limit as string, 10) || 10;
			const userId = req.user?.sub;

			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const result = await ArchivedEmailService.getArchivedEmails(
				ingestionSourceId,
				page,
				limit,
				userId
			);
			return res.status(200).json(result);
		} catch (error) {
			console.error('Get archived emails error:', error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getArchivedEmailById = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;

			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const email = await ArchivedEmailService.getArchivedEmailById(
				id,
				userId,
				actor,
				req.ip || 'unknown'
			);
			if (!email) {
				return res.status(404).json({ message: req.t('archivedEmail.notFound') });
			}
			return res.status(200).json(email);
		} catch (error) {
			console.error(`Get archived email by id ${req.params.id} error:`, error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getArchivedEmailContent = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;

			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			// Flags are strict `true`/`false` so a typo like `includeHtml=yes` is reported instead
			// of silently meaning "no".
			const flag = (value: unknown): boolean | null => {
				if (value === undefined || value === 'false') return false;
				return value === 'true' ? true : null;
			};
			const includeHtml = flag(req.query.includeHtml);
			const includeAttachmentText = flag(req.query.includeAttachmentText);
			if (includeHtml === null || includeAttachmentText === null) {
				return res.status(400).json({ message: req.t('archivedEmail.invalidFlag') });
			}

			let maxChars: number | undefined;
			if (req.query.maxChars !== undefined) {
				maxChars = Number(req.query.maxChars);
				if (
					typeof req.query.maxChars !== 'string' ||
					!/^\d+$/.test(req.query.maxChars) ||
					maxChars < 1
				) {
					return res
						.status(400)
						.json({ message: req.t('archivedEmail.invalidMaxChars') });
				}
			}

			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const content = await ArchivedEmailService.getArchivedEmailContent(
				id,
				userId,
				actor,
				req.ip || 'unknown',
				{ includeHtml, includeAttachmentText, maxChars }
			);
			if (!content) {
				return res.status(404).json({ message: req.t('archivedEmail.notFound') });
			}
			return res.status(200).json(content);
		} catch (error) {
			console.error(`Get archived email content ${req.params.id} error:`, error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public deleteArchivedEmail = async (req: Request, res: Response): Promise<Response> => {
		// Guard: return 400 if deletion is disabled in system settings before touching anything else
		try {
			checkDeletionEnabled();
		} catch (error) {
			return res.status(400).json({
				message: error instanceof Error ? error.message : req.t('errors.deletionDisabled'),
			});
		}

		const { id } = req.params;
		const userId = req.user?.sub;
		if (!userId) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}
		const actor = await this.userService.findById(userId);
		if (!actor) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}

		try {
			await ArchivedEmailService.deleteArchivedEmail(id, actor, req.ip || 'unknown');
			return res.status(204).send();
		} catch (error) {
			console.error(`Delete archived email ${req.params.id} error:`, error);
			if (error instanceof Error) {
				if (error.message === 'Archived email not found') {
					return res.status(404).json({ message: req.t('archivedEmail.notFound') });
				}
				// Retention policy / legal hold blocks are user-facing 400 errors
				if (error.message.startsWith('Deletion blocked by retention policy')) {
					return res.status(400).json({ message: error.message });
				}
				return res.status(500).json({ message: error.message });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};
}
