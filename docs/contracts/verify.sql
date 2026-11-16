\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.expect_rejection(statement text, expected_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE observed text;
BEGIN
 BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS observed=RETURNED_SQLSTATE; END;
 IF observed IS DISTINCT FROM expected_state THEN RAISE EXCEPTION 'Expected %, got % for %',expected_state,observed,statement; END IF;
END $$;
INSERT INTO users(id,email,password_hash,status) VALUES
 (md5('u1')::uuid,'one@example.invalid','test-hash','active'),(md5('u2')::uuid,'two@example.invalid','test-hash','active');
INSERT INTO queries(id,user_id,canonical_query_hash,normalizer_version,normalized_query,filters,marketplace,window_days,price_basis,requested_limit,as_of,billing_policy_version,compute_status,settlement_status,result_state,expires_at)
 VALUES(md5('q1')::uuid,md5('u1')::uuid,'hash','1.1','synthetic','{}','ebay_us',90,'item',50,now(),'1.1','completed','pending','ready',now()+interval '24 hours');
INSERT INTO credit_wallets(id,user_id,bucket_identity,bucket_type,balance,status)
 VALUES(md5('w1')::uuid,md5('u1')::uuid,'purchase:1','purchased',1,'active');
SELECT pg_temp.expect_rejection($s$UPDATE credit_wallets SET balance=-1$s$,'23514');
SELECT pg_temp.expect_rejection($s$UPDATE credit_wallets SET expires_at=now()$s$,'23514');
SELECT pg_temp.expect_rejection($s$INSERT INTO credit_wallets(user_id,bucket_identity,bucket_type,balance,status) VALUES(md5('u1')::uuid,'purchase:1','purchased',1,'active')$s$,'23505');
SELECT pg_temp.expect_rejection($s$INSERT INTO billing_charges(query_id,user_id,charged_credits,policy_version,result_hash,state) VALUES(md5('q1')::uuid,md5('u2')::uuid,1,'1.1','h','charged')$s$,'23503');
INSERT INTO credit_grants(id,user_id,wallet_id,grant_identity,amount) VALUES(md5('g1')::uuid,md5('u1')::uuid,md5('w1')::uuid,'payment:1',1);
SELECT pg_temp.expect_rejection($s$INSERT INTO credit_grants(user_id,wallet_id,grant_identity,amount) VALUES(md5('u1')::uuid,md5('w1')::uuid,'payment:1',1)$s$,'23505');
INSERT INTO credit_ledger(id,wallet_id,user_id,delta,balance_after,kind,grant_id,ref_type,ref_id,idempotency_key)
 VALUES(md5('l1')::uuid,md5('w1')::uuid,md5('u1')::uuid,1,1,'grant',md5('g1')::uuid,'payment','1','grant:1');
INSERT INTO billing_charges(id,query_id,user_id,charged_credits,policy_version,result_hash,state)
 VALUES(md5('c1')::uuid,md5('q1')::uuid,md5('u1')::uuid,1,'1.1','h','charged');
UPDATE credit_wallets SET balance=balance-1 WHERE id=md5('w1')::uuid AND balance>=1;
INSERT INTO credit_ledger(id,wallet_id,user_id,delta,balance_after,kind,charge_id,ref_type,ref_id,idempotency_key)
 VALUES(md5('l2')::uuid,md5('w1')::uuid,md5('u1')::uuid,-1,0,'consume',md5('c1')::uuid,'query','1','charge:1');
SELECT pg_temp.expect_rejection($s$INSERT INTO billing_charges(query_id,user_id,charged_credits,policy_version,result_hash,state) VALUES(md5('q1')::uuid,md5('u1')::uuid,1,'1.1','h','charged')$s$,'23505');
SELECT pg_temp.expect_rejection($s$INSERT INTO credit_ledger(wallet_id,user_id,delta,balance_after,kind,charge_id,ref_type,ref_id,idempotency_key) VALUES(md5('w1')::uuid,md5('u1')::uuid,-1,0,'consume',md5('c1')::uuid,'query','1','other')$s$,'23505');
SELECT pg_temp.expect_rejection($s$UPDATE credit_ledger SET reason='rewrite'$s$,'23514');
SELECT pg_temp.expect_rejection($s$DELETE FROM credit_ledger$s$,'23514');
SELECT pg_temp.expect_rejection($s$INSERT INTO credit_ledger(wallet_id,user_id,delta,balance_after,kind,ref_type,ref_id,idempotency_key) VALUES(md5('w1')::uuid,md5('u2')::uuid,1,1,'adjust','manual','1','cross-owner')$s$,'23503');
DO $$ BEGIN
 IF (SELECT balance FROM credit_wallets WHERE id=md5('w1')::uuid)<>(SELECT sum(delta) FROM credit_ledger WHERE wallet_id=md5('w1')::uuid) THEN RAISE EXCEPTION 'ledger mismatch'; END IF;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_rejection($s$UPDATE credit_wallets SET balance=1 WHERE id=md5('w1')::uuid; SET CONSTRAINTS ALL IMMEDIATE$s$,'23514');
SELECT pg_temp.expect_rejection($s$INSERT INTO credit_ledger(wallet_id,user_id,delta,balance_after,kind,charge_id,refund_of,ref_type,ref_id,idempotency_key) VALUES(md5('w1')::uuid,md5('u1')::uuid,1,1,'refund',md5('c1')::uuid,md5('l1')::uuid,'query','1','bad-refund')$s$,'23514');
INSERT INTO query_jobs(query_id,dedupe_key,status,available_at,expires_at) VALUES(md5('q1')::uuid,'owner-query','queued',now(),now()+interval '24 hours');
SELECT pg_temp.expect_rejection($s$INSERT INTO query_jobs(query_id,dedupe_key,status,available_at,expires_at) VALUES(md5('q1')::uuid,'owner-query','running',now(),now()+interval '24 hours')$s$,'23505');
SELECT pg_temp.expect_rejection($s$INSERT INTO shares(query_id,user_id,token_hash,field_scope,expires_at) VALUES(md5('q1')::uuid,md5('u2')::uuid,'secret-hash','{}',now()+interval '1 hour')$s$,'23503');
INSERT INTO anonymous_quota VALUES('rotated',current_date,5);
SELECT pg_temp.expect_rejection($s$UPDATE anonymous_quota SET used_count=6$s$,'23514');
INSERT INTO source_clearances(id,provider,dataset,revision,status) VALUES(md5('cl')::uuid,'synthetic','not-a-license',1,'draft');
SELECT pg_temp.expect_rejection($s$UPDATE source_clearances SET status='active'$s$,'23514');
INSERT INTO sources(id,source_clearance_id,marketplace,access_method,collector_version,entrypoint_id,status) VALUES
 (md5('s1')::uuid,md5('cl')::uuid,'ebay_us','offline_fixture','test','synthetic','disabled'),
 (md5('s2')::uuid,md5('cl')::uuid,'ebay_us','offline_fixture','test','synthetic','disabled');
INSERT INTO collector_configs(id,source_id,collector_version,allowed_entrypoints,access_method,rate_cap,concurrency_cap,max_pages,max_bytes_per_job)
 VALUES(md5('cfg')::uuid,md5('s1')::uuid,'test','[]','offline_fixture',1,1,1,100);
INSERT INTO collector_runs(id,source_id,config_id,query_hash,collector_version,parser_version,permission_snapshot_hash,started_at)
 VALUES(md5('run')::uuid,md5('s1')::uuid,md5('cfg')::uuid,'h','test','test','no-license',now());
SELECT pg_temp.expect_rejection($s$INSERT INTO source_observations(source_id,collector_run_id,captured_at,raw_hash,parser_version,record_count,permitted_visibility) VALUES(md5('s2')::uuid,md5('run')::uuid,now(),'h','test',1,'{}')$s$,'23503');
INSERT INTO source_observations(id,source_id,collector_run_id,captured_at,raw_hash,parser_version,record_count,permitted_visibility)
 VALUES(md5('obs')::uuid,md5('s1')::uuid,md5('run')::uuid,now(),'h','test',1,'{}');
INSERT INTO sold_listings(id,source_id,marketplace,external_listing_id,first_seen_at,last_seen_at)
 VALUES(md5('listing')::uuid,md5('s1')::uuid,'ebay_us','item-1',now(),now());
INSERT INTO sale_events(id,listing_id,source_id,observation_id,source_event_key,event_identity_status,sold_at,sold_date_precision,sale_format,sale_price_status,item_price_cents,observed_shipping_status,currency,evidence_kind,evidence_ref,first_seen_at)
 VALUES(md5('event')::uuid,md5('listing')::uuid,md5('s1')::uuid,md5('obs')::uuid,'event-1','verified',now(),'second','fixed_price','verified_actual',100,'unknown','USD','synthetic','synthetic-only',now());
SELECT pg_temp.expect_rejection($s$UPDATE sale_events SET evidence_ref=NULL$s$,'23514');
SELECT pg_temp.expect_rejection($s$UPDATE sale_events SET observed_shipping_cents=0$s$,'23514');
SELECT pg_temp.expect_rejection($s$UPDATE sale_events SET item_price_cents=-1$s$,'23514');
SELECT pg_temp.expect_rejection($s$UPDATE sale_events SET source_id=md5('s2')::uuid$s$,'23503');
INSERT INTO source_daily_budget VALUES(md5('s1')::uuid,current_date,'pages',1,1,0);
SELECT pg_temp.expect_rejection($s$UPDATE source_daily_budget SET used=1$s$,'23514');
INSERT INTO payment_events(provider,provider_event_id,event_type,payload_ref,status) VALUES('test','evt1','test','synthetic','received');
SELECT pg_temp.expect_rejection($s$INSERT INTO payment_events(provider,provider_event_id,event_type,payload_ref,status) VALUES('test','evt1','test','synthetic','received')$s$,'23505');
INSERT INTO audit_events(action,object_type,object_id,request_id) VALUES('test','test','test','test');
SELECT pg_temp.expect_rejection($s$DELETE FROM audit_events$s$,'23514');
SELECT 'PASS: 24 negative constraints plus owner/source consistency and deferred ledger reconciliation' AS result;
ROLLBACK;
