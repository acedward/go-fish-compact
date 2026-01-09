import {type CircuitContext} from '@midnight-ntwrk/compact-runtime';
import {ledger} from '../go-fish/contract/index.js';

export let currentPlayer: number | null = null;
export const setCurrentPlayer1 = () => {
	currentPlayer = 1;
};

export const setCurrentPlayer2 = () => {
	currentPlayer = 2;
};

import * as readline from 'readline';
import {CardSimulator} from './card-simulator.js';
import {PrivateState} from './witnesses.js';

// Game state
type GamePhase = 'setup' | 'playing' | 'ended';
type GameState = {
	phase: GamePhase;
	currentTurn: number; // 1 or 2
	playerHands: {
		player1: bigint[];
		player2: bigint[];
	};
	books: {
		player1: number[]; // Array of rank indices (0-12) that have been completed
		player2: number[];
	};
	deckInitialized: boolean;
	player1Shuffled: boolean;
	player2Shuffled: boolean;
};

let simulator: CardSimulator | null = null;
let gameState: GameState = {
	phase: 'setup',
	currentTurn: 1,
	playerHands: {
		player1: [],
		player2: [],
	},
	books: {
		player1: [],
		player2: [],
	},
	deckInitialized: false,
	player1Shuffled: false,
	player2Shuffled: false,
};

// Game setup functions

export async function initializeDeck(
	sim: CardSimulator,
): Promise<{success: boolean; context: CircuitContext<PrivateState>}> {
	try {
		const r1 = sim.contract.impureCircuits.init_deck(sim.circuitContext);
		return {success: true, context: r1.context};
	} catch (error: any) {
		return {success: false, context: sim.circuitContext};
	}
}

export async function shuffleDeck(
	sim: CardSimulator,
	player: number,
): Promise<{success: boolean; context: CircuitContext<PrivateState>}> {
	if (player === 1) {
		setCurrentPlayer1();
	} else {
		setCurrentPlayer2();
	}

	try {
		const playerIndex = BigInt(player);
		const impureCircuits = sim.contract.impureCircuits as any;
		const r = impureCircuits.apply_mask_to_deck(
			sim.circuitContext,
			playerIndex,
		);
		return {success: true, context: r.context};
	} catch (error: any) {
		return {success: false, context: sim.circuitContext};
	}
}

export async function dealInitialCards(
	sim: CardSimulator,
	drawCardFn: (sim: CardSimulator, player: number) => Promise<bigint>,
	hasCardsFn: (sim: CardSimulator) => boolean,
): Promise<{
	success: boolean;
	hands: {player1: bigint[]; player2: bigint[]};
	context: CircuitContext<PrivateState>;
}> {
	const hands = {player1: [] as bigint[], player2: [] as bigint[]};
	let currentContext = sim.circuitContext;

	// Deal 7 cards to player 1
	for (let i = 0; i < 7; i++) {
		if (!hasCardsFn(sim)) {
			return {success: false, hands, context: currentContext};
		}
		try {
			const card = await drawCardFn(sim, 1);
			hands.player1.push(card);
			currentContext = sim.circuitContext; // Update context after each draw
		} catch (error: any) {
			return {success: false, hands, context: currentContext};
		}
	}

	// Deal 7 cards to player 2
	for (let i = 0; i < 7; i++) {
		if (!hasCardsFn(sim)) {
			return {success: false, hands, context: currentContext};
		}
		try {
			const card = await drawCardFn(sim, 2);
			hands.player2.push(card);
			currentContext = sim.circuitContext; // Update context after each draw
		} catch (error: any) {
			return {success: false, hands, context: currentContext};
		}
	}

	return {success: true, hands, context: currentContext};
}

// Helper functions for GO Fish game logic

/**
 * Get the rank (0-12) from a card value (0-51)
 * 0 = Ace, 1-9 = 2-10, 10 = Jack, 11 = Queen, 12 = King
 */
export function getCardRank(cardValue: bigint): number {
	const value = Number(cardValue);
	if (value >= 0 && value < 13) return value; // Spades: A,2-10,J,Q,K
	if (value >= 14 && value < 27) return value - 14; // Hearts
	if (value >= 28 && value < 41) return value - 28; // Diamonds
	if (value >= 42 && value < 52) return value - 42; // Clubs (note: 51 is the last card)
	// Handle edge case where value 13, 27, 41 might exist
	return value % 13;
}

/**
 * Get rank name from rank index (0-12)
 */
export function getRankName(rank: number): string {
	const rankNames = [
		'A',
		'2',
		'3',
		'4',
		'5',
		'6',
		'7',
		'8',
		'9',
		'10',
		'J',
		'Q',
		'K',
	];
	return rankNames[rank] || '?';
}

export function formatCard(cardValue: bigint): string {
	const value = Number(cardValue);
	const rankNames = [
		'A',
		'2',
		'3',
		'4',
		'5',
		'6',
		'7',
		'8',
		'9',
		'10',
		'J',
		'Q',
		'K',
	];

	let suit: string;
	let rankIndex: number;

	if (value >= 0 && value <= 13) {
		suit = '|S';
		rankIndex = value;
	} else if (value >= 14 && value <= 27) {
		suit = '|H';
		rankIndex = value - 14;
	} else if (value >= 28 && value <= 41) {
		suit = '|D';
		rankIndex = value - 28;
	} else if (value >= 42 && value <= 51) {
		suit = '|T';
		rankIndex = value - 42;
	} else {
		return `${cardValue}`;
	}

	// Handle edge case where rankIndex might be out of bounds (e.g., value 13 in 0-13 range)
	if (rankIndex < 0 || rankIndex >= rankNames.length) {
		// Wrap around if out of bounds
		rankIndex = rankIndex % rankNames.length;
	}

	return `${suit}${rankNames[rankIndex]}|`;
}

/**
 * Group cards by rank and return a map of rank -> count
 */
export function groupCardsByRank(hand: bigint[]): Map<number, bigint[]> {
	const grouped = new Map<number, bigint[]>();
	for (const card of hand) {
		const rank = getCardRank(card);
		if (!grouped.has(rank)) {
			grouped.set(rank, []);
		}
		grouped.get(rank)!.push(card);
	}
	return grouped;
}

/**
 * Check for books (4 cards of the same rank) in a hand and return new books
 */
export function checkForBooks(
	hand: bigint[],
	existingBooks: number[],
): number[] {
	const grouped = groupCardsByRank(hand);
	const newBooks: number[] = [];

	for (const [rank, cards] of grouped.entries()) {
		if (cards.length === 4 && !existingBooks.includes(rank)) {
			newBooks.push(rank);
		}
	}

	return newBooks;
}

/**
 * Remove all cards of a specific rank from a hand
 */
export function removeCardsOfRank(
	hand: bigint[],
	rank: number,
): {removed: bigint[]; remaining: bigint[]} {
	const removed: bigint[] = [];
	const remaining: bigint[] = [];

	for (const card of hand) {
		if (getCardRank(card) === rank) {
			removed.push(card);
		} else {
			remaining.push(card);
		}
	}

	return {removed, remaining};
}

/**
 * Draw a card from the deck for a specific player
 * The contract's getTopCard handles one partial decryption and adds to player's hand
 * We then fully decrypt it to get the card value for display
 * NOTE: Using type assertions for go-fish contract methods until contract is compiled
 */
export async function drawCardFromDeck(
	sim: CardSimulator,
	player: number,
): Promise<bigint> {
	// Get the top card from the deck - contract handles one partial decryption and adds to player's hand
	// Type assertion needed until go-fish contract is compiled with updated getTopCard signature
	const circuits = sim.contract.circuits;
	const r1 = circuits.getTopCard(sim.circuitContext, BigInt(player));
	sim.circuitContext = r1.context;
	const partiallyDecryptedPoint = r1.result; // Still encrypted with drawing player's key

	// Fully decrypt: the card was decrypted with the other player's key in getTopCard,
	// so now we need to decrypt with the drawing player's key
	const drawingPlayerId = BigInt(player);
	if (player === 1) {
		setCurrentPlayer1();
	} else {
		setCurrentPlayer2();
	}
	const r2 = circuits.partial_decryption(
		sim.circuitContext,
		partiallyDecryptedPoint,
		drawingPlayerId,
	);
	sim.circuitContext = r2.context;
	const unmaskedPoint = r2.result;

	// Get card from point
	const r3 = sim.contract.circuits.getCardFromPoint(
		sim.circuitContext,
		unmaskedPoint,
	);
	sim.circuitContext = r3.context;
	const cardValue = r3.result;

	return cardValue;
}

/**
 * Check if a player has a card of a specific rank using the contract
 * NOTE: This requires the go-fish contract to be compiled with doesPlayerHaveCard circuit
 */
async function checkPlayerHasCard(
	player: number,
	rank: number,
): Promise<boolean> {
	if (!simulator) {
		throw new Error('Simulator not initialized');
	}

	try {
		const playerNum = BigInt(player);
		const rankField = BigInt(rank);
		// Type assertion needed until go-fish contract is compiled and imported
		const circuits = simulator.contract.circuits as any;
		if (circuits.doesPlayerHaveCard) {
			const result = circuits.doesPlayerHaveCard(
				simulator.circuitContext,
				playerNum,
				rankField,
			);
			simulator.circuitContext = result.context;
			return result.result;
		} else {
			// Fallback to local check if contract function not available
			const askedHand =
				gameState.playerHands[player === 1 ? 'player1' : 'player2'];
			const {removed} = removeCardsOfRank(askedHand, rank);
			return removed.length > 0;
		}
	} catch (error: any) {
		// Fallback to local check on error
		const askedHand =
			gameState.playerHands[player === 1 ? 'player1' : 'player2'];
		const {removed} = removeCardsOfRank(askedHand, rank);
		return removed.length > 0;
	}
}

/**
 * Check if deck has cards remaining
 */
export function hasCardsRemaining(sim: CardSimulator): boolean {
	try {
		const contractLedger = ledger(sim.circuitContext.currentQueryContext.state);
		return contractLedger.topCardIndex < contractLedger.deckSize;
	} catch {
		return false;
	}
}

// Game display and management functions

function checkAndRemoveBooks(player: number) {
	const playerKey = player === 1 ? 'player1' : 'player2';
	const hand = gameState.playerHands[playerKey];
	const existingBooks = gameState.books[playerKey];

	const newBooks = checkForBooks(hand, existingBooks);

	if (newBooks.length > 0) {
		for (const rank of newBooks) {
			// Remove all 4 cards of this rank from hand
			const {remaining} = removeCardsOfRank(hand, rank);
			gameState.playerHands[playerKey] = remaining;
			gameState.books[playerKey].push(rank);
		}
	}

	return newBooks.length > 0;
}

function displayPlayerHand(_player: number, _showCards: boolean = true) {
	// Display function removed - UI handles display
	// This function is kept for compatibility but does nothing
}

function displayGameStatus() {
	// Display function removed - UI handles display
	// This function is kept for compatibility but does nothing
}

function checkGameEnd(): boolean {
	// Game ends when a player has no cards left and deck is empty, or all 13 books are completed
	const totalBooks =
		gameState.books.player1.length + gameState.books.player2.length;

	if (totalBooks >= 13) {
		return true;
	}

	const p1HandEmpty = gameState.playerHands.player1.length === 0;
	const p2HandEmpty = gameState.playerHands.player2.length === 0;
	const deckEmpty = simulator ? !hasCardsRemaining(simulator) : true;

	if ((p1HandEmpty || p2HandEmpty) && deckEmpty) {
		return true;
	}

	return false;
}

function getWinner(): {player: number; score: number} | null {
	const p1Score = gameState.books.player1.length;
	const p2Score = gameState.books.player2.length;

	if (p1Score > p2Score) {
		return {player: 1, score: p1Score};
	} else if (p2Score > p1Score) {
		return {player: 2, score: p2Score};
	} else {
		return null; // Tie
	}
}

// Main turn logic

async function handlePlayerTurn(rl: readline.Interface): Promise<void> {
	const currentPlayer = gameState.currentTurn;
	const currentHand =
		gameState.playerHands[currentPlayer === 1 ? 'player1' : 'player2'];

	// Check if player has any cards
	if (currentHand.length === 0) {
		if (simulator && hasCardsRemaining(simulator)) {
			try {
				const card = await drawCardFromDeck(simulator, currentPlayer);
				gameState.playerHands[currentPlayer === 1 ? 'player1' : 'player2'].push(
					card,
				);
				checkAndRemoveBooks(currentPlayer);

				// Check if game ended
				if (checkGameEnd()) {
					endGame(rl);
					return;
				}
			} catch (error: any) {
				// Error handling - UI will display
			}
		} else {
			// Switch turns
			gameState.currentTurn = currentPlayer === 1 ? 2 : 1;
			await handlePlayerTurn(rl);
			return;
		}
	}

	displayGameStatus();

	// Get available ranks in player's hand
	const grouped = groupCardsByRank(currentHand);
	const availableRanks = Array.from(grouped.keys()).sort((a, b) => a - b);

	if (availableRanks.length === 0) {
		if (simulator && hasCardsRemaining(simulator)) {
			try {
				const card = await drawCardFromDeck(simulator, currentPlayer);
				gameState.playerHands[currentPlayer === 1 ? 'player1' : 'player2'].push(
					card,
				);
				checkAndRemoveBooks(currentPlayer);
			} catch (error: any) {
				// Error handling - UI will display
			}
		}

		if (checkGameEnd()) {
			endGame(rl);
			return;
		}

		gameState.currentTurn = currentPlayer === 1 ? 2 : 1;
		await handlePlayerTurn(rl);
		return;
	}

	rl.question(
		`\nWhich rank do you want to ask for? (1-${availableRanks.length} or rank name): `,
		async rankInput => {
			let selectedRank: number | undefined = undefined;

			// Try to parse as number
			const rankNum = parseInt(rankInput.trim());
			if (!isNaN(rankNum) && rankNum >= 1 && rankNum <= availableRanks.length) {
				selectedRank = availableRanks[rankNum - 1];
			} else {
				// Try to match by name
				const rankNames = [
					'A',
					'2',
					'3',
					'4',
					'5',
					'6',
					'7',
					'8',
					'9',
					'10',
					'J',
					'Q',
					'K',
				];
				const inputUpper = rankInput.trim().toUpperCase();
				const rankIndex = rankNames.findIndex(name => name === inputUpper);
				if (rankIndex !== -1 && availableRanks.includes(rankIndex)) {
					selectedRank = rankIndex;
				}
			}

			if (selectedRank === null) {
				await handlePlayerTurn(rl);
				return;
			}

			// Ask which player to ask
			const opponent = currentPlayer === 1 ? 2 : 1;
			rl.question(
				`Ask Player ${opponent} for ${getRankName(selectedRank!)}s? (y/n): `,
				async answer => {
					if (
						answer.trim().toLowerCase() !== 'y' &&
						answer.trim().toLowerCase() !== 'yes'
					) {
						await handlePlayerTurn(rl);
						return;
					}

					await processAskForCards(currentPlayer, opponent, selectedRank!, rl);
				},
			);
		},
	);
}

async function processAskForCards(
	askingPlayer: number,
	askedPlayer: number,
	rank: number,
	rl: readline.Interface,
): Promise<void> {
	// Use the contract to check if the player has cards of this rank
	const hasCard = await checkPlayerHasCard(askedPlayer, rank);

	if (hasCard) {
		// Opponent has the cards - transfer them
		// Note: In a real contract implementation, we'd need to get all cards of this rank from the contract
		// For now, we'll use the local hand tracking and the contract will verify
		const askedHand =
			gameState.playerHands[askedPlayer === 1 ? 'player1' : 'player2'];
		const {removed, remaining} = removeCardsOfRank(askedHand, rank);

		if (removed.length > 0) {
			const askingHand =
				gameState.playerHands[askingPlayer === 1 ? 'player1' : 'player2'];
			askingHand.push(...removed);
			gameState.playerHands[askedPlayer === 1 ? 'player1' : 'player2'] =
				remaining;

			// Check for books
			checkAndRemoveBooks(askingPlayer);

			// Check if game ended
			if (checkGameEnd()) {
				endGame(rl);
				return;
			}

			// Player got cards, so they continue their turn
			await handlePlayerTurn(rl);
			return;
		}
	}

	// Player doesn't have the card or no cards were found
	{
		// GO Fish!
		if (simulator && hasCardsRemaining(simulator)) {
			try {
				const card = await drawCardFromDeck(simulator, askingPlayer);
				const askingHand =
					gameState.playerHands[askingPlayer === 1 ? 'player1' : 'player2'];
				askingHand.push(card);

				const drawnRank = getCardRank(card);
				if (drawnRank === rank) {
					checkAndRemoveBooks(askingPlayer);

					if (checkGameEnd()) {
						endGame(rl);
						return;
					}

					// Player goes again if they got what they asked for
					await handlePlayerTurn(rl);
					return;
				}

				checkAndRemoveBooks(askingPlayer);
			} catch (error: any) {
				// Error handling - UI will display
			}
		}
	}

	// Check if game ended
	if (checkGameEnd()) {
		endGame(rl);
		return;
	}

	// Switch turns
	gameState.currentTurn = askingPlayer === 1 ? 2 : 1;
	await handlePlayerTurn(rl);
}

function endGame(rl: readline.Interface) {
	displayPlayerHand(1, true);
	displayPlayerHand(2, true);

	getWinner(); // Winner info available via getWinner() - UI will display
	rl.close();
	process.exit(0);
}

// async function startGame(rl: readline.Interface) {
//   // Step 1: Initialize deck
//   if (!(await initializeDeck())) {
//     rl.close();
//     process.exit(1);
//   }

//   // Step 2: Player 1 shuffles
//   if (!(await shuffleDeck(1))) {
//     rl.close();
//     process.exit(1);
//   }

//   // Step 3: Player 2 shuffles
//   if (!(await shuffleDeck(2))) {
//     rl.close();
//     process.exit(1);
//   }

//   // Step 4: Deal cards
//   if (!(await dealInitialCards())) {
//     rl.close();
//     process.exit(1);
//   }

//   // Start the game
//   gameState.phase = "playing";

//   await handlePlayerTurn(rl);
// }

// Main function removed - app.tsx is the entry point using Ink
// async function main() {
//   simulator = new CardSimulator();
//
//   const rl = readline.createInterface({
//     input: process.stdin,
//     output: process.stdout,
//   });
//
//   // Start the GO Fish game
//   await startGame(rl);
// }
//
// main().catch((error) => {
//   console.error("Fatal error:", error);
//   process.exit(1);
// });
