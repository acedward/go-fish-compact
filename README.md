# go-fish-compact
<img width="100%" alt="Screenshot 2026-01-09 at 7 10 57 PM" src="https://github.com/user-attachments/assets/5875ac01-c40a-4d74-aa3d-faecb8333c70" />

### Cryptogra

We use `EC-SRA` Commutative Encryption property where:
$$ecMul(ecMul(P, Key_A), Key_B) = ecMul(ecMul(P, Key_B), Key_A)$$

<img width="100%" src="./image.png">

### Requirements
* `node`
* `compact 0.27.0+

```sh
npm install
npm run compile
npm run start
```

### Test
```sh
npm install
npm run compile
npm run test
```

