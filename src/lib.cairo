use starknet::ContractAddress;

pub const VALIDATED: felt252 = 'VALID';
pub const VIRTUAL_SNOS: felt252 = 'VIRTUAL_SNOS';
pub const VIRTUAL_SNOS0: felt252 = 'VIRTUAL_SNOS0';

// SNIP-12 revision-1 constants for the typed-data schema:
//   StarknetDomain { name: shortstring, version: shortstring, chainId: shortstring, revision: shortstring }
//   Consent        { secret: felt, min_balance: u256, token: ContractAddress }
// Constants are precomputed in client/src/computeTypeHashes.ts so the Cairo
// `signed_hash` matches what Argent X / Braavos sign via `wallet_signTypedData`.
pub const SN_MESSAGE: felt252 = 0x537461726b4e6574204d657373616765;
pub const SNIP12_DOMAIN_TYPE_HASH: felt252 =
    0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210;
pub const SNIP12_CONSENT_TYPE_HASH: felt252 =
    0x101811b9e19f67cce7ea03842506512df607f343c9277b692470897e58093b4;
pub const SNIP12_U256_TYPE_HASH: felt252 =
    0x3b143be38b811560b45593fb2a071ec4ddd0a020e10782be62ffe6f39e0e82c;
pub const SNIP12_DOMAIN_NAME: felt252 = 'ProofOfSolvency';
// starknet.js's typedData encoder parses pure-digit strings as decimals, so
// version "1" and revision "1" both encode to felt 0x1, not the shortstring 0x31.
pub const SNIP12_DOMAIN_VERSION: felt252 = 0x1;
pub const SNIP12_DOMAIN_REVISION: felt252 = 0x1;

#[starknet::interface]
pub trait IFactRegistry<TContractState> {
    fn verify_sig_and_balance(
        ref self: TContractState,
        account: ContractAddress,
        secret: felt252,
        signature: Array<felt252>,
        min_balance: u256,
        token: ContractAddress,
    );
    fn register_fact(ref self: TContractState, slot: felt252, sender: ContractAddress);
    fn is_fact_registered(self: @TContractState, slot: felt252) -> bool;
    fn is_allowed_sender(self: @TContractState, sender: ContractAddress) -> bool;
    fn is_allowed_program_hash(self: @TContractState, program_hash: felt252) -> bool;
}

#[starknet::interface]
pub trait IAccount<TContractState> {
    fn is_valid_signature(
        self: @TContractState, hash: felt252, signature: Array<felt252>,
    ) -> felt252;
}

#[starknet::interface]
pub trait IERC20<TContractState> {
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
}

#[starknet::contract]
pub mod FactRegistry {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::{get_execution_info_v3_syscall, send_message_to_l1_syscall};
    use starknet::{
        ContractAddress, SyscallResultTrait, get_block_number, get_contract_address, get_tx_info,
    };
    use super::{
        IAccountDispatcher, IAccountDispatcherTrait, IERC20Dispatcher, IERC20DispatcherTrait,
        IFactRegistry, SN_MESSAGE, SNIP12_CONSENT_TYPE_HASH, SNIP12_DOMAIN_NAME,
        SNIP12_DOMAIN_REVISION, SNIP12_DOMAIN_TYPE_HASH, SNIP12_DOMAIN_VERSION,
        SNIP12_U256_TYPE_HASH, VALIDATED, VIRTUAL_SNOS, VIRTUAL_SNOS0,
    };

    #[storage]
    struct Storage {
        facts: Map<felt252, bool>,
        // Set of program hashes that may produce facts (one per proof variant —
        // e.g., direct ERC-20 vs. pool anonymizer flow).
        allowed_program_hashes: Map<felt252, bool>,
        // Set of senders allowed to emit the L2->L1 slot message inside a virtual
        // block. Always includes this registry itself (so `verify_sig_and_balance`
        // works); also includes each approved anonymizer address.
        allowed_senders: Map<ContractAddress, bool>,
        proof_validity_blocks: u64,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        SolvencyFactRegistered: SolvencyFactRegistered,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SolvencyFactRegistered {
        #[key]
        pub slot: felt252,
    }

    #[derive(Drop, Serde, Copy)]
    struct ProofFacts {
        proof_version: felt252,
        program_variant: felt252,
        virtual_program_hash: felt252,
        starknet_os_output_version: felt252,
        base_block_number: u64,
        base_block_hash: felt252,
        starknet_os_config_hash: felt252,
        message_to_l1_hashes: Span<felt252>,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        program_hashes: Span<felt252>,
        anonymizer_senders: Span<ContractAddress>,
        proof_validity_blocks: u64,
    ) {
        assert(!program_hashes.is_empty(), 'no program hashes');
        assert(proof_validity_blocks.is_non_zero(), 'zero validity blocks');
        for hash in program_hashes {
            assert((*hash).is_non_zero(), 'zero program hash');
            self.allowed_program_hashes.write(*hash, true);
        }
        // Registry itself is always an allowed sender (for the direct ERC-20 flow
        // where this contract emits the L1 message from `verify_sig_and_balance`).
        self.allowed_senders.write(get_contract_address(), true);
        for sender in anonymizer_senders {
            assert((*sender).is_non_zero(), 'zero anonymizer addr');
            self.allowed_senders.write(*sender, true);
        }
        self.proof_validity_blocks.write(proof_validity_blocks);
    }

    #[abi(embed_v0)]
    pub impl FactRegistryImpl of IFactRegistry<ContractState> {
        fn verify_sig_and_balance(
            ref self: ContractState,
            account: ContractAddress,
            secret: felt252,
            signature: Array<felt252>,
            min_balance: u256,
            token: ContractAddress,
        ) {
            assert(account.is_non_zero(), 'zero account');
            assert(secret.is_non_zero(), 'zero secret');
            assert(min_balance.is_non_zero(), 'zero min_balance');
            assert(token.is_non_zero(), 'zero token');

            // SNIP-12 revision-1 typed-data hash so Argent X / Braavos can sign via
            // `wallet_signTypedData`. The schema and type-hash constants are pinned
            // in client/src/computeTypeHashes.ts and mirrored at the top of this file.
            let signed_hash = compute_snip12_consent_hash(account, secret, min_balance, token);

            let account_dispatcher = IAccountDispatcher { contract_address: account };
            let valid = account_dispatcher.is_valid_signature(signed_hash, signature);
            assert(valid == VALIDATED, 'invalid signature');

            let token_dispatcher = IERC20Dispatcher { contract_address: token };
            let balance = token_dispatcher.balance_of(account);
            assert(balance >= min_balance, 'balance below min');

            // Same slot shape as the pool flow — see `pool_anonymizer.cairo`. Pool
            // proofs use threshold as a u128 (high = 0); ERC-20 proofs may use the
            // full u256, so threshold of e.g. 10 STRK lands on the same slot here
            // and via the pool anonymizer.
            let slot = compute_slot(secret, get_block_number(), min_balance, token);

            send_message_to_l1_syscall(to_address: Zero::zero(), payload: array![slot].span())
                .unwrap_syscall();
        }

        fn register_fact(ref self: ContractState, slot: felt252, sender: ContractAddress) {
            assert(self.allowed_senders.read(sender), 'sender not allowed');

            let execution_info = get_execution_info_v3_syscall().unwrap_syscall();
            let mut proof_facts_span = execution_info.tx_info.proof_facts;
            assert(!proof_facts_span.is_empty(), 'empty proof facts');
            let proof_facts: ProofFacts = Serde::deserialize(ref proof_facts_span)
                .expect('proof facts deserialize error');
            assert(proof_facts_span.is_empty(), 'invalid proof facts');

            assert(proof_facts.program_variant == VIRTUAL_SNOS, 'invalid variant');
            assert(
                proof_facts.starknet_os_output_version == VIRTUAL_SNOS0, 'invalid output version',
            );
            assert(
                self.allowed_program_hashes.read(proof_facts.virtual_program_hash),
                'program hash not allowed',
            );

            let current_block = execution_info.block_info.block_number;
            assert(proof_facts.base_block_number < current_block, 'invalid base block');
            assert(
                current_block <= proof_facts.base_block_number + self.proof_validity_blocks.read(),
                'proof expired',
            );

            // The pool emits its own L2->L1 message (`send_message_to_server` in
            // privacy::utils) on every tx, so we look up `slot` from `sender`
            // among the emitted messages instead of asserting equality.
            let expected_msg_hash = compute_message_hash(slot, sender);
            assert(
                contains_hash(proof_facts.message_to_l1_hashes, expected_msg_hash),
                'slot msg missing',
            );

            self.facts.write(slot, true);
            self.emit(SolvencyFactRegistered { slot });
        }

        fn is_fact_registered(self: @ContractState, slot: felt252) -> bool {
            self.facts.read(slot)
        }

        fn is_allowed_sender(self: @ContractState, sender: ContractAddress) -> bool {
            self.allowed_senders.read(sender)
        }

        fn is_allowed_program_hash(self: @ContractState, program_hash: felt252) -> bool {
            self.allowed_program_hashes.read(program_hash)
        }
    }

    /// Reconstructs the L1 message hash for a message sent from `from_address`
    /// with payload=[slot] and to_address=0. Mirrors the format used by
    /// VIRTUAL_SNOS to populate `proof_facts.message_to_l1_hashes`.
    fn compute_message_hash(slot: felt252, from_address: ContractAddress) -> felt252 {
        let mut l1_message_data: Array<felt252> = array![from_address.into(), Zero::zero()];
        let payload = array![slot];
        payload.serialize(ref l1_message_data);
        poseidon_hash_span(l1_message_data.span())
    }

    fn contains_hash(mut hashes: Span<felt252>, needle: felt252) -> bool {
        loop {
            match hashes.pop_front() {
                Some(h) => { if *h == needle { break true; } },
                None => { break false; },
            }
        }
    }

    /// SNIP-12 revision-1 message hash for the Consent schema.
    ///
    ///   StarkNet Message
    ///     || hash(StarknetDomain)
    ///     || account
    ///     || hash(Consent { secret, min_balance: u256, token })
    ///
    /// Reproduces what starknet.js's `typedData.getMessageHash` computes for the
    /// schema defined in client/src/lib/typedData.ts, so a wallet signature on
    /// that typed data validates here via `is_valid_signature`.
    fn compute_snip12_consent_hash(
        account: ContractAddress, secret: felt252, min_balance: u256, token: ContractAddress,
    ) -> felt252 {
        let chain_id = get_tx_info().unbox().chain_id;
        let domain_hash = poseidon_hash_span(
            array![
                SNIP12_DOMAIN_TYPE_HASH,
                SNIP12_DOMAIN_NAME,
                SNIP12_DOMAIN_VERSION,
                chain_id,
                SNIP12_DOMAIN_REVISION,
            ]
                .span(),
        );
        let u256_hash = poseidon_hash_span(
            array![SNIP12_U256_TYPE_HASH, min_balance.low.into(), min_balance.high.into()].span(),
        );
        let consent_hash = poseidon_hash_span(
            array![SNIP12_CONSENT_TYPE_HASH, secret, u256_hash, token.into()].span(),
        );
        poseidon_hash_span(
            array![SN_MESSAGE, domain_hash, account.into(), consent_hash].span(),
        )
    }

    pub fn compute_slot(
        secret: felt252, block_number: u64, threshold: u256, token: ContractAddress,
    ) -> felt252 {
        let secret_hash = poseidon_hash_span(array![secret].span());
        poseidon_hash_span(
            array![
                secret_hash,
                block_number.into(),
                threshold.low.into(),
                threshold.high.into(),
                token.into(),
            ]
                .span(),
        )
    }
}

#[starknet::contract]
pub mod PoolSolvencyAnonymizer {
    //! Privacy-pool anonymizer for proving solvency.
    //!
    //! Called by the privacy contract via the `privacy_invoke` selector. The pool
    //! tx flow that invokes this contract is:
    //!
    //!   UseNote(s)                 -> consume the user's existing note(s)
    //!   Withdraw(amount -> self)   -> pool sends `amount` of `token` to this contract
    //!   InvokeExternal(self, ...)  -> calls this `privacy_invoke`, which asserts
    //!                                 `amount >= threshold` and emits the slot
    //!   CreateOpenNote             -> a fresh open note owned by the user
    //!   (then the returned OpenNoteDeposit re-deposits `amount` into it)
    //!
    //! Net token movement: zero. Output: an L2->L1 message with `payload=[slot]`
    //! that `FactRegistry.register_fact(slot, self)` consumes.

    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use privacy::objects::OpenNoteDeposit;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::send_message_to_l1_syscall;
    use starknet::{
        ContractAddress, SyscallResultTrait, get_block_number, get_caller_address,
    };
    use super::{IERC20Dispatcher, IERC20DispatcherTrait};

    #[starknet::interface]
    pub trait IPoolSolvencyAnonymizer<T> {
        /// Asserts `amount >= threshold`, emits an L2->L1 message with the
        /// solvency `slot`, approves the privacy contract to pull `amount` of
        /// `token` back, and returns a single `OpenNoteDeposit` so the pool
        /// re-deposits the same amount into `note_id`.
        ///
        /// Calldata layout matches the privacy pool's call convention: the pool
        /// forwards the `Span<felt252>` carried by `InvokeExternalInput.calldata`
        /// as the arguments to this entrypoint.
        ///
        /// # Arguments
        /// * `threshold` — minimum balance we're claiming the user holds.
        /// * `token` — ERC-20 contract; must equal the token of the withdrawn note.
        /// * `amount` — amount the pool just withdrew to this contract.
        /// * `note_id` — open note the pool will deposit `amount` into.
        /// * `secret` — user-chosen felt; folded into the slot so the same fact
        ///   on the same block/threshold/token can be re-proved under a fresh
        ///   slot by varying the secret.
        fn privacy_invoke(
            ref self: T,
            threshold: u128,
            token: ContractAddress,
            amount: u128,
            note_id: felt252,
            secret: felt252,
        ) -> Span<OpenNoteDeposit>;

        fn privacy_contract(self: @T) -> ContractAddress;
    }

    #[storage]
    struct Storage {
        privacy_contract: ContractAddress,
    }

    pub mod errors {
        pub const ZERO_PRIVACY_CONTRACT: felt252 = 'ZERO_PRIVACY_CONTRACT';
        pub const CALLER_NOT_PRIVACY: felt252 = 'CALLER_NOT_PRIVACY';
        pub const ZERO_THRESHOLD: felt252 = 'ZERO_THRESHOLD';
        pub const ZERO_TOKEN: felt252 = 'ZERO_TOKEN';
        pub const ZERO_AMOUNT: felt252 = 'ZERO_AMOUNT';
        pub const ZERO_NOTE_ID: felt252 = 'ZERO_NOTE_ID';
        pub const ZERO_SECRET: felt252 = 'ZERO_SECRET';
        pub const BELOW_THRESHOLD: felt252 = 'BELOW_THRESHOLD';
    }

    #[constructor]
    fn constructor(ref self: ContractState, privacy_contract: ContractAddress) {
        assert(privacy_contract.is_non_zero(), errors::ZERO_PRIVACY_CONTRACT);
        self.privacy_contract.write(privacy_contract);
    }

    #[abi(embed_v0)]
    pub impl PoolSolvencyAnonymizerImpl of IPoolSolvencyAnonymizer<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            threshold: u128,
            token: ContractAddress,
            amount: u128,
            note_id: felt252,
            secret: felt252,
        ) -> Span<OpenNoteDeposit> {
            let privacy_addr = self.privacy_contract.read();
            assert(get_caller_address() == privacy_addr, errors::CALLER_NOT_PRIVACY);

            assert(threshold.is_non_zero(), errors::ZERO_THRESHOLD);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(note_id.is_non_zero(), errors::ZERO_NOTE_ID);
            assert(secret.is_non_zero(), errors::ZERO_SECRET);

            // The actual solvency check. Pool guarantees `amount` was just
            // withdrawn from a note the caller owned and that hadn't been spent
            // before this tx — that's what makes this a proof of ownership.
            assert(amount >= threshold, errors::BELOW_THRESHOLD);

            // Same slot shape as the direct-ERC-20 path: H(H(secret), block,
            // threshold.lo=threshold, threshold.hi=0, token).
            let threshold_u256 = u256 { low: threshold, high: 0 };
            let slot = compute_pool_slot(
                secret, get_block_number(), threshold_u256, token,
            );

            send_message_to_l1_syscall(to_address: Zero::zero(), payload: array![slot].span())
                .unwrap_syscall();

            // Approve the pool to pull `amount` of `token` back so the open-note
            // deposit can settle. The pool will `transfer_from(self, pool, amount)`.
            let amount_u256 = u256 { low: amount, high: 0 };
            IERC20Dispatcher { contract_address: token }
                .approve(spender: privacy_addr, amount: amount_u256);

            [OpenNoteDeposit { note_id, token, amount }].span()
        }

        fn privacy_contract(self: @ContractState) -> ContractAddress {
            self.privacy_contract.read()
        }
    }

    /// Replicated from `FactRegistry::compute_slot` so the anonymizer doesn't
    /// pull the registry's storage. Kept byte-identical — see test in
    /// client/src/computeTypeHashes.ts that pins the slot format.
    fn compute_pool_slot(
        secret: felt252, block_number: u64, threshold: u256, token: ContractAddress,
    ) -> felt252 {
        let secret_hash = poseidon_hash_span(array![secret].span());
        poseidon_hash_span(
            array![
                secret_hash,
                block_number.into(),
                threshold.low.into(),
                threshold.high.into(),
                token.into(),
            ]
                .span(),
        )
    }
}
