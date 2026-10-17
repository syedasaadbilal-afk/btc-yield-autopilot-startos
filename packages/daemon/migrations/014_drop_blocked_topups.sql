-- Blocked idle top-ups were dust (below the exchange minimum) retried every
-- tick; they never moved money and only cluttered the Timeline. The loop no
-- longer logs them, so remove the historical ones.
DELETE FROM execution_log WHERE kind = 'topup' AND status = 'blocked';
