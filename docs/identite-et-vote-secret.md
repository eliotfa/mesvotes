# Identité des inscrits et secret du vote

Document de décision. Il ne change pas le code : il propose un chemin et liste ce qui reste à trancher.

## Le problème

**Un compte n'est pas une personne.** Aujourd'hui, un inscrit peut créer plusieurs comptes avec plusieurs adresses e-mail. Dans une démocratie directe, cela fausse directement le résultat : le quorum (5 %) et la majorité se calculent sur des comptes, pas sur des personnes. Le même problème touche les jurys de modération, tirés au sort parmi les comptes.

**Le vote n'était pas secret.** La table `votes` reliait chaque choix à un `user_id` (corrigé par l'étape 1 ci-dessous). Les résultats publics sont agrégés, mais un administrateur qui accède au serveur peut lire qui a voté quoi. C'est une limite assumée pour l'instant (README, « Sécurité et limites connues ») : elle doit être traitée avant d'ouvrir largement la plateforme.

## Identité : les options

| Option | Ce qu'elle garantit | Limites | Coût / complexité |
|---|---|---|---|
| **A. E-mail + téléphone (SMS)** | Un numéro de téléphone par compte, ce qui freine la multiplication des comptes. | Un téléphone peut se multiplier ; données personnelles à protéger. | Faible. Un fournisseur SMS à brancher. |
| **B. Parrainage de confiance** (chaque membre vérifié en parraine un autre) | Pas de donnée d'identité collectée ; le réseau de confiance dissuade les faux comptes. | Peut exclure des personnes isolées ; un réseau peut se fabriquer. | Moyen. Règles de parrainage, sanctions si un parrain fait entrer des faux comptes. |
| **C. Vérification d'identité par prestataire (KYC)** (pièce d'identité + selfie) | Un compte = une personne, de façon solide. | Donnée biométrique et pièce d'identité : RGPD strict, analyse d'impact, sous-traitant à contractualiser. Coût par vérification. Exclut ceux qui n'ont pas de pièce valide. | Élevé. Prestataire, contrat de sous-traitance, politique de conservation. |
| **D. FranceConnect / France Identité** | Identité officielle, sans collecte directe. | Réservé aux services partenaires de l'État ; ne s'ouvre pas à un projet citoyen sans agrément. | Très élevé, incertain. |

**Recommandation : un système à deux niveaux**, plutôt qu'une barrière unique.

- **Niveau 1 (aujourd'hui)** : e-mail confirmé, puis téléphone (option A). Tout le monde peut proposer, amender et débattre.
- **Niveau 2 (vérifié)** : parrainage de confiance ou KYC (options B ou C). Requis pour **voter** et pour **parrainer**.
- Les votes des niveaux 1 et 2 sont **comptés et affichés séparément**, sur le modèle déjà en place pour les votes des mineurs. Le résultat dit clairement ce qu'il représente.
- Les jurys de modération restent tirés au sort parmi les niveaux 2 dès que possible.

Ce choix transforme une décision binaire (« on exige l'identité ou pas ») en un réglage que la communauté peut voter lui-même, par révision de la Constitution.

## Secret du vote : les étapes

**Étape 1 — séparer qui a voté de ce qui a été voté (faible coût).** *Faite (migration v5) : tables `vote_participations` / `ballots` et `case_ballots` pour les jurys. Le `ballot_id` est l'empreinte d'un code de vote généré par le serveur et remis une seule fois, plutôt qu'un secret gardé dans le navigateur, pour que le vote fonctionne sur une tablette partagée. La date de participation est arrondie au jour et l'urne n'en porte aucune.*
- Une table `participations(proposal_id, user_id)` sert à empêcher de voter deux fois et à compter la participation.
- Une table `bulletins(proposal_id, ballot_id, choice)` ne contient ni `user_id` ni date précise (arrondie à l'heure).
- Le `ballot_id` est dérivé côté navigateur d'un secret propre à l'inscrit (`HMAC(secret_inscrit, proposition)`). Il permet de changer d'avis sans que le serveur sache qui est derrière.
- Limite : un administrateur qui voit à la fois la liste des participants et l'ordre d'insertion peut encore faire des rapprochements. L'étape 1 protège contre la lecture simple, pas contre un administrateur déterminé.

**Étape 2 — jetons anonymes (protection réelle).**
- Le serveur signe à l'aveugle un jeton par électeur éligible (signature aveugle RSA ou équivalent). Le serveur ne peut pas relier le jeton signé à la personne qui l'a demandé.
- Le bulletin est déposé avec le jeton, pas avec le compte. Un jeton ne sert qu'une fois.
- Changer d'avis : un nouveau jeton remplace l'ancien bulletin, avec une preuve de validité qui ne révèle rien sur l'identité.
- C'est le seul niveau qui répond vraiment à la question « un administrateur peut-il savoir qui a voté quoi ? » : non.

## Ce que je recommande comme prochaine étape

1. Ajouter la vérification du téléphone (niveau 1) et un statut de niveau par compte, sans encore rien bloquer.
2. Décider du niveau requis pour voter (révision de la Constitution), une fois le système de niveaux en place.
3. Faire l'étape 1 du secret du vote avant la prochaine vraie consultation.
4. Rédiger l'analyse d'impact (opinions politiques = donnée sensible au sens du RGPD) **avant** de collecter une donnée d'identité.

## Questions ouvertes

- Budget acceptable pour une vérification payante par personne ?
- Acceptez-vous qu'une partie des membres (sans pièce d'identité valide) soit moins représentée dans les votes de niveau 2 ?
- Qui a le droit de modifier le niveau requis : seulement une révision votée, ou aussi les administrateurs ?
