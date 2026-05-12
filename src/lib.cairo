use starknet::ContractAddress;
use starknet::account::Call;

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
    /// Same shape of claim ("account holds >= min_balance of token at block N"),
    /// but the balance is the sum of unspent privacy-pool notes the caller owns
    /// instead of the public ERC-20 balance. Slot is identical so the two paths
    /// share the registry.
    ///
    /// `note_indices` lists the indices (within the self-channel for `token`)
    /// of the notes being asserted. The contract recomputes each note_id from
    /// (channel_key, token, index), reads the encrypted note from `pool`,
    /// decrypts the amount on-chain, and checks the nullifier hasn't been
    /// published.
    ///
    /// `viewing_key` is the secret needed to (a) produce the nullifier and
    /// (b) ratify the self-channel (it's the user's pool spending key). It
    /// never leaves the proving service — the wallet still only signs the
    /// SNIP-12 Consent over (secret, min_balance, token).
    fn verify_sig_and_pool_balance(
        ref self: TContractState,
        account: ContractAddress,
        secret: felt252,
        signature: Array<felt252>,
        min_balance: u256,
        token: ContractAddress,
        pool: ContractAddress,
        channel_key: felt252,
        viewing_key: felt252,
        token_index: u32,
        note_indices: Span<u32>,
    );
    fn register_fact(ref self: TContractState, slot: felt252);
    fn is_fact_registered(self: @TContractState, slot: felt252) -> bool;
}

#[starknet::interface]
pub trait IAccount<TContractState> {
    fn is_valid_signature(
        self: @TContractState, hash: felt252, signature: Array<felt252>,
    ) -> felt252;
}

/// Account-shape interface exposed by the FactRegistry itself, so the
/// proving service can use the registry as the `sender_address` of the
/// virtual INVOKE that wraps `verify_sig_and_balance` /
/// `verify_sig_and_pool_balance`. The registry's on-chain nonce stays
/// at zero forever (see `__validate__`), so every proving run can pass
/// `nonce = 0` without ever colliding with the relayer's nonce — that
/// removes the race that produced INVALID_NONCE errors when two proofs
/// were submitted sequentially.
#[starknet::interface]
pub trait IRegistryAccount<TContractState> {
    fn __validate__(self: @TContractState, calls: Array<Call>) -> felt252;
    fn __execute__(ref self: TContractState, calls: Array<Call>) -> Array<Span<felt252>>;
}

#[starknet::interface]
pub trait IERC20<TContractState> {
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
}

#[starknet::contract(account)]
pub mod FactRegistry {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::account::Call;
    use starknet::syscalls::{
        call_contract_syscall, get_execution_info_v3_syscall, send_message_to_l1_syscall,
    };
    use starknet::{
        ContractAddress, SyscallResultTrait, get_block_number, get_contract_address, get_tx_info,
    };
    use privacy::interface::{IViewsDispatcher, IViewsDispatcherTrait};
    use privacy::hashes::domain_separation::{
        ENC_AMOUNT_TAG, ENC_TOKEN_TAG, NOTE_ID_TAG, NULLIFIER_TAG, SUBCHANNEL_ID_TAG,
    };
    use super::{
        IAccountDispatcher, IAccountDispatcherTrait, IERC20Dispatcher, IERC20DispatcherTrait,
        IFactRegistry, IRegistryAccount, SN_MESSAGE, SNIP12_CONSENT_TYPE_HASH, SNIP12_DOMAIN_NAME,
        SNIP12_DOMAIN_REVISION, SNIP12_DOMAIN_TYPE_HASH, SNIP12_DOMAIN_VERSION,
        SNIP12_U256_TYPE_HASH, VALIDATED, VIRTUAL_SNOS, VIRTUAL_SNOS0,
    };

    /// Felt mask for the low 128 bits of a packed_value or encrypted-amount
    /// hash. Encrypted amounts wrap mod 2^128 inside the pool.
    const TWO_POW_128: felt252 = 0x100000000000000000000000000000000;
    const TWO_POW_128_U256: u256 = 0x100000000000000000000000000000000;

    #[storage]
    struct Storage {
        facts: Map<felt252, bool>,
        expected_program_hash: felt252,
        proof_validity_blocks: u64,
        // Pool contract whose view functions the pool-solvency path queries.
        // Pinned at construction so a caller can't pass a fake pool that
        // always returns "note exists / nullifier doesn't exist".
        privacy_pool: ContractAddress,
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
        expected_program_hash: felt252,
        proof_validity_blocks: u64,
        privacy_pool: ContractAddress,
    ) {
        assert(expected_program_hash.is_non_zero(), 'zero program hash');
        assert(proof_validity_blocks.is_non_zero(), 'zero validity blocks');
        assert(privacy_pool.is_non_zero(), 'zero privacy pool');
        self.expected_program_hash.write(expected_program_hash);
        self.proof_validity_blocks.write(proof_validity_blocks);
        self.privacy_pool.write(privacy_pool);
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

            // output = h(h(secret), block_number, min_balance, token).
            // block_number is the base block inside VIRTUAL_SNOS — the block in which balance was observed.
            let secret_hash = poseidon_hash_span(array![secret].span());
            let output = poseidon_hash_span(
                array![
                    secret_hash,
                    get_block_number().into(),
                    min_balance.low.into(),
                    min_balance.high.into(),
                    token.into(),
                ]
                    .span(),
            );

            send_message_to_l1_syscall(to_address: Zero::zero(), payload: array![output].span())
                .unwrap_syscall();
        }

        fn verify_sig_and_pool_balance(
            ref self: ContractState,
            account: ContractAddress,
            secret: felt252,
            signature: Array<felt252>,
            min_balance: u256,
            token: ContractAddress,
            pool: ContractAddress,
            channel_key: felt252,
            viewing_key: felt252,
            token_index: u32,
            note_indices: Span<u32>,
        ) {
            assert(account.is_non_zero(), 'zero account');
            assert(secret.is_non_zero(), 'zero secret');
            assert(min_balance.is_non_zero(), 'zero min_balance');
            assert(token.is_non_zero(), 'zero token');
            assert(channel_key.is_non_zero(), 'zero channel_key');
            assert(viewing_key.is_non_zero(), 'zero viewing_key');
            assert(note_indices.len().is_non_zero(), 'no note indices');
            assert(pool == self.privacy_pool.read(), 'wrong privacy pool');

            // Same SNIP-12 Consent the ERC-20 path uses — keeps the wallet UX
            // identical and lets a relying party that already accepts a
            // verify_sig_and_balance signature accept this one too.
            let signed_hash = compute_snip12_consent_hash(account, secret, min_balance, token);
            let account_dispatcher = IAccountDispatcher { contract_address: account };
            let valid = account_dispatcher.is_valid_signature(signed_hash, signature);
            assert(valid == VALIDATED, 'invalid signature');

            // Cross-check `token`: the pool stores the token only inside the
            // encrypted subchannel info (Note.token = 0 for encrypted notes),
            // so without this step a caller could lie about which token the
            // notes represent and still pass amount checks.
            let pool_views = IViewsDispatcher { contract_address: pool };
            let subchannel_id = poseidon_hash_span(
                array![SUBCHANNEL_ID_TAG, channel_key, token_index.into(), Zero::zero()].span(),
            );
            let subchannel = pool_views.get_subchannel_info(subchannel_id);
            assert(subchannel.salt.is_non_zero(), 'subchannel not setup');
            let enc_token_mask = poseidon_hash_span(
                array![ENC_TOKEN_TAG, channel_key, token_index.into(), Zero::zero(), subchannel.salt]
                    .span(),
            );
            // enc_token = mask + token  =>  token = enc_token - mask
            assert(subchannel.enc_token - enc_token_mask == token.into(), 'token mismatch');

            // For each claimed note: rebuild the note_id from (channel_key,
            // token, index), pull packed_value off-chain, decrypt the amount,
            // and check the nullifier hasn't been published yet. Indices must
            // be strictly increasing so the caller can't double-count a note
            // by listing the same index twice.
            let mut total: u256 = 0;
            let mut indices = note_indices;
            let mut prev_idx: u32 = 0;
            let mut first = true;
            loop {
                match indices.pop_front() {
                    Some(idx_ref) => {
                        let idx = *idx_ref;
                        // index 0 is a valid note slot — the first deposit
                        // in a self-channel lives there.
                        if !first {
                            assert(idx > prev_idx, 'indices not sorted');
                        }
                        first = false;
                        prev_idx = idx;

                        let note_id = poseidon_hash_span(
                            array![
                                NOTE_ID_TAG, channel_key, token.into(), idx.into(), Zero::zero(),
                            ]
                                .span(),
                        );
                        let note = pool_views.get_note(note_id);
                        assert(note.packed_value.is_non_zero(), 'note missing');

                        // unpack(packed_value) → (salt: u128, enc_amount: u128)
                        let packed_u256: u256 = note.packed_value.into();
                        let salt: u128 = packed_u256.high;
                        let enc_amount: u128 = packed_u256.low;

                        let mask_hash = poseidon_hash_span(
                            array![
                                ENC_AMOUNT_TAG, channel_key, token.into(), idx.into(),
                                Zero::zero(), salt.into(),
                            ]
                                .span(),
                        );
                        // amount = (enc_amount - mask.low128) mod 2^128
                        let mask_full: u256 = mask_hash.into();
                        let mask_low: u128 = mask_full.low;
                        // Wrapping u128 subtraction.
                        let amount: u128 = if enc_amount >= mask_low {
                            enc_amount - mask_low
                        } else {
                            // wrap mod 2^128
                            let diff: u256 = TWO_POW_128_U256 + enc_amount.into() - mask_low.into();
                            diff.low
                        };

                        let nullifier = poseidon_hash_span(
                            array![
                                NULLIFIER_TAG, channel_key, token.into(), idx.into(),
                                Zero::zero(), viewing_key,
                            ]
                                .span(),
                        );
                        assert(!pool_views.nullifier_exists(nullifier), 'note already spent');

                        total = total + amount.into();
                    },
                    None => { break; },
                }
            }
            assert(total >= min_balance, 'balance below min');

            // Same slot shape as verify_sig_and_balance — a pool-balance claim
            // for the same (account, secret, min_balance, token, block) lands
            // on the same fact slot. register_fact stays one entrypoint.
            let secret_hash = poseidon_hash_span(array![secret].span());
            let output = poseidon_hash_span(
                array![
                    secret_hash,
                    get_block_number().into(),
                    min_balance.low.into(),
                    min_balance.high.into(),
                    token.into(),
                ]
                    .span(),
            );
            send_message_to_l1_syscall(to_address: Zero::zero(), payload: array![output].span())
                .unwrap_syscall();
        }

        fn register_fact(ref self: ContractState, slot: felt252) {
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
                proof_facts.virtual_program_hash == self.expected_program_hash.read(),
                'invalid program hash',
            );

            let current_block = execution_info.block_info.block_number;
            assert(proof_facts.base_block_number < current_block, 'invalid base block');
            assert(
                current_block <= proof_facts.base_block_number + self.proof_validity_blocks.read(),
                'proof expired',
            );

            let expected_msg_hash = compute_message_hash(slot, get_contract_address());
            assert(
                proof_facts.message_to_l1_hashes == [expected_msg_hash].span(),
                'invalid message hash',
            );

            self.facts.write(slot, true);
            self.emit(SolvencyFactRegistered { slot });
        }

        fn is_fact_registered(self: @ContractState, slot: felt252) -> bool {
            self.facts.read(slot)
        }
    }

    /// Account entry points so the proving service can use the registry as
    /// the sender of the virtual INVOKE that wraps a `verify_sig_*` call.
    ///
    /// `__validate__` asserts the L2-gas price and tip are zero — the
    /// sequencer rejects any real tx with a zero L2-gas price, so this is
    /// what pins the registry to the virtual path. Without that, anyone
    /// could send a real INVOKE from this address and bump its nonce,
    /// which would re-introduce the historical-vs-latest nonce race.
    /// Same convention the privacy pool's `__validate__` uses
    /// (starknet-privacy/packages/privacy/src/privacy.cairo:165-179).
    ///
    /// `__execute__` only dispatches calls back to this contract — the
    /// account exists solely to wrap the registry's own predicate entry
    /// points (`verify_sig_and_balance`, `verify_sig_and_pool_balance`).
    /// The selector itself is not pinned here so future predicates can be
    /// added without touching this impl.
    #[abi(embed_v0)]
    pub impl RegistryAccountImpl of IRegistryAccount<ContractState> {
        fn __validate__(self: @ContractState, calls: Array<Call>) -> felt252 {
            let tx_info = get_tx_info().unbox();
            assert(tx_info.tip.is_zero(), 'tip not zero');
            for resource_bounds in tx_info.resource_bounds {
                if *resource_bounds.resource == 'L2_GAS' {
                    assert(
                        resource_bounds.max_price_per_unit.is_zero(), 'l2_gas price not zero',
                    );
                }
            }
            VALIDATED
        }

        fn __execute__(
            ref self: ContractState, calls: Array<Call>,
        ) -> Array<Span<felt252>> {
            assert(calls.len() == 1, 'expected single call');
            let call = calls.at(0);
            assert(*call.to == get_contract_address(), 'unauthorized to');
            let result = call_contract_syscall(*call.to, *call.selector, *call.calldata)
                .unwrap_syscall();
            array![result]
        }
    }

    /// Reconstructs the L1 message hash for a message sent from this contract with payload=[slot]
    /// and to_address=0. Mirrors the format used by VIRTUAL_SNOS to populate
    /// `proof_facts.message_to_l1_hashes`.
    fn compute_message_hash(slot: felt252, contract_address: ContractAddress) -> felt252 {
        let mut l1_message_data: Array<felt252> = array![contract_address.into(), Zero::zero()];
        let payload = array![slot];
        payload.serialize(ref l1_message_data);
        poseidon_hash_span(l1_message_data.span())
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
}
